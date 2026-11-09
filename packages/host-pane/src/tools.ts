import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { offersPage, type PageId, pageById, pageIds, requirePage } from '@oryh/ai-client-pages'
import { NAVIGATION_WITHOUT_PANE, NO_PAGE, OPEN_KEEPS_PAGE, UNSAVED_KEEPS_PAGE } from './notices.js'
import type { PaneService } from './service.js'
import type { PaneContext } from './types.js'

/** The shape of a tool that answers with text. */
/**
 * Whether an opening tool brings the business view forward. On a narrow screen Chat and the business
 * view take turns: a page the agent opens to answer, or to show what it just wrote, must not take the
 * person away from the reply they are reading. Only what they asked to see comes forward; the rest
 * opens behind Chat, and the switch is marked.
 */
export const SHOW_PARAMETER = {
  type: 'boolean',
  description:
    '用户明确要求查看或打开它时传 true；为回答问题、或写入后顺带展示结果时不传。窄屏上只有 true 会把用户从 Chat 切到业务视图，不传时在后台打开；用户在当前页面有未保存内容时，不传 true 不会切换页面。',
} as const

/** A navigation payload's reveal flag: present only when asked to show. */
export const reveal = (show: unknown): { reveal?: true } => (show === true ? { reveal: true } : {})

export const textOutput = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** The generic part of a page's context: what every page reports, without the page-specific sections. */
function genericContext(context: PaneContext | undefined) {
  if (context === undefined) return undefined
  const { todos: _todos, ...generic } = context
  return generic
}

/** What the page shows, for the model, in the shape each page's tools read. */
function visible(page: PageId, context: PaneContext | undefined, revision: number) {
  if (context === undefined) return undefined
  if (page === 'my-open-todos' && context.todos)
    return {
      visibleTodos: context.todos.visibleTodos,
      listRevision: context.todos.listRevision,
      todoId: context.todos.todoId,
    }
  return undefined
}

/** What a page lets the agent do here, said in words the model acts on. */
function capabilities(page: PageId) {
  return { notice: '页面工具用于在中间栏展示和编辑；业务写入按对应的 skill 在对话里完成。' }
}

/**
 * The current page, as `oryh_current_page` and the page context report it.
 * @param pane - the pane service.
 * @param sessionId - session asking.
 * @returns the page, its context, the person's menu and what the agent may do here.
 * @throws the no-page notice when nothing is synced.
 */
export function currentPage(pane: PaneService, sessionId: string) {
  const session = pane.page(sessionId)
  const context = session.context
  return {
    page: session.page,
    title: context?.view?.label ?? pageById(session.page)?.title ?? session.page,
    revision: session.revision,
    context: genericContext(context),
    // The role's entries first, as the menu shows them; all open with oryh_open_view by id. One a colleague
    // shared says who (`sharedBy`), and one of the person's own that they share says so (`shared`).
    userMenu: menuForAgent(pane, sessionId),
    visible: visible(session.page, context, session.revision),
    capabilities: capabilities(session.page),
    instruction: '这是当前界面，不以聊天历史中的旧页面为准。',
  }
}

function menuForAgent(pane: PaneService, sessionId: string) {
  const sharing = new Set(pane.frame(sessionId).state.sharedOwn ?? [])
  return pane.entries(sessionId).map(({ id, label, collection, filters, sharedBy }) => ({
    id,
    label,
    collection,
    filters,
    ...(sharedBy ? { sharedBy } : {}),
    ...(sharing.has(id) ? { shared: true } : {}),
  }))
}

/**
 * Whether the person has a record or a form open, rather than a list they are browsing.
 * @param except - a record that is no interruption to have open: the one about to be opened.
 */
function hasOpen(pane: PaneService, sessionId: string, except?: string): boolean {
  const key = pane.session(sessionId)?.context?.key
  if (key === undefined || key.endsWith(':list')) return false
  return except === undefined || !key.endsWith(`:${except}`)
}

/**
 * Open a page in the business pane and wait for it to show.
 *
 * The pane may not be open at all, which is exactly when navigating is worth trying: reading the
 * current page first would refuse the one case this tool exists for. Nothing answering then is a
 * fact to report, not a failure of the request.
 */
export async function navigate(pane: PaneService, sessionId: string, page: PageId, signal: AbortSignal, show = false) {
  const home = pane.home(sessionId)
  const before = pane.session(sessionId)?.page !== undefined ? currentPage(pane, sessionId) : undefined
  const { connection } = await pane.verified(sessionId)
  if (!offersPage(page)) throw new Error('这个客户端没有这个页面。要看这类数据，用自定义页面或菜单里的自定义列表。')
  requirePage(connection.identity, page)
  const payload = { target: 'page' as const, page, ...reveal(show) }
  // The person is typing on another page and did not ask to see this one: it stays where it is, and the
  // agent is told so as an answer rather than a failure, since it has done nothing wrong.
  if (pane.wouldDisplace(sessionId, { lane: 'navigation', page, payload }))
    return JSON.stringify({ opened: false, notice: UNSAVED_KEEPS_PAGE })
  // Nor does a page opened to go with an answer replace a record or a form they have open. Reading already
  // follows only a person who is browsing a list (docs/56 §10); a tool the agent calls for itself took
  // the page all the same, and a question asked beside an open timesheet left them on the orders list.
  if (!show && pane.session(sessionId)?.page !== page && hasOpen(pane, sessionId))
    return JSON.stringify({ opened: false, notice: OPEN_KEEPS_PAGE })
  // Asked for the page already showing, the pane is still told: on a narrow screen the person may be
  // looking at Chat, and only the pane's own navigation brings the business view back to the front.
  try {
    return await pane.issue<string>(
      sessionId,
      // With no pane open there is nobody to answer, so that case is not worth a long wait.
      {
        lane: 'navigation',
        page,
        payload,
        timeoutMs: before ? 15_000 : 4_000,
      },
      id => ({
        invalid: () => (pane.session(sessionId)?.connectionId !== home.connectionId ? '页面导航已取消。' : undefined),
        until: () =>
          pane.session(sessionId)?.page === page && pane.acked(sessionId, id)
            ? JSON.stringify(currentPage(pane, sessionId))
            : undefined,
        expired: '网页未确认导航，请重新读取当前页面。',
        signal,
      }),
    )
  } catch (error) {
    if (!before && pane.session(sessionId)?.page === undefined)
      return JSON.stringify({ opened: false, notice: NAVIGATION_WITHOUT_PANE })
    throw error
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Narrow the list on the page by its own conditions — a keyword, a status, a span of dates — and wait
 * for the page to show it so. The conditions given are the list's conditions: one left out is cleared.
 * @param args - `text`, `status`, `from`, `to`, each optional.
 * @returns the page as it then stands.
 */
export async function filterList(
  pane: PaneService,
  sessionId: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  // A page just opened says what it can be narrowed by a moment after it shows. Asked in that moment — an
  // agent that navigates and filters in one breath — a list that could be narrowed was refused as one that
  // could not, so the page is given that moment before it is taken at its word.
  for (const deadline = Date.now() + 2000; Date.now() < deadline && !signal.aborted; ) {
    if (pane.page(sessionId).context?.listFilter) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const session = pane.page(sessionId)
  const filter = session.context?.listFilter
  if (!filter || !session.context?.key.endsWith(':list'))
    throw new OryhClientError(
      '当前页面不是可以这样筛选的列表。待办列表可以；菜单里的销售订单、库存、收发货列表用 oryh_record_query；其它自定义列表的条件是固定的。',
      'request-failed',
    )
  const values: Record<string, string> = {}
  for (const name of filter.fields) {
    const value = args[name]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string' || value.length > 200) throw new OryhClientError(`${name} 无效。`, 'request-failed')
    if ((name === 'from' || name === 'to') && !DAY.test(value))
      throw new OryhClientError(`${name} 要写成 YYYY-MM-DD。`, 'request-failed')
    values[name] = value.trim()
  }
  if (values.from && values.to && values.from > values.to)
    throw new OryhClientError('from 不能晚于 to。', 'request-failed')
  const wanted = Object.fromEntries(filter.fields.map(name => [name, values[name] ?? '']))
  return pane.issue<string>(
    sessionId,
    {
      lane: 'navigation',
      page: session.page,
      payload: { target: 'filters', page: session.page, queryValues: values },
      timeoutMs: 10_000,
    },
    id => ({
      until: () => {
        const now = pane.session(sessionId)
        return pane.acked(sessionId, id) &&
          now?.page === session.page &&
          JSON.stringify(now.context?.listFilter?.values) === JSON.stringify(wanted)
          ? JSON.stringify(currentPage(pane, sessionId))
          : undefined
      },
      expired: '页面没有确认筛选，请重新读取当前页面。',
      signal,
    }),
  )
}

/** The tools the pane itself offers, named for the agent's allow-list. */
export const PANE_TOOLS: readonly string[] = [
  'oryh_current_page',
  'oryh_navigate',
  'oryh_open_record',
  'oryh_list_filter',
]

/** Register the page tools every page shares: what is showing, and going somewhere else. */
export function installPaneTools(ctx: Context, pane: PaneService): void {
  ctx.tools.register(
    defineTool({
      name: 'oryh_current_page',
      description:
        '读取中间栏当前页面的列表、详情或表单上下文，以及用户自建的菜单项。用户提到“这个”“当前单据”或需要页面上的数据时调用；页面切换后以此为准，不沿用历史页面。没有打开的页面时返回 page 为空。同时返回 clock：用户时区里此刻的日期和时间（clock.now）。',
      parameters: {},
      output: textOutput,
      execute: async (_args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        const id = String(exec.agent.id)
        // The time to the second is given here, on request, and not in the standing context: there it
        // would change with every turn and the model would re-read the whole conversation each time.
        const clock = pane.clock(id)
        if (pane.session(id)?.page === undefined) return JSON.stringify({ page: null, notice: NO_PAGE, clock })
        await pane.refreshMenu(id).catch(() => {})
        return JSON.stringify({ ...currentPage(pane, id), clock })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_open_record',
      description:
        '在中间栏打开一条 ORYH 记录的详情。resource 是它所在的集合，即接口路径里的名字（如 todos）；id 是记录的编号（接口返回的 id，不是单号）。记录不在列表当前页、或被筛选条件挡住时也能打开。用户想看某张单据，或你在回答里讲到某张单据、希望用户对照着看时调用。只有中间栏有页面的集合能打开，其它的会如实告诉你打不开。返回 opened:false 时照实说明原因并继续回答，不重复尝试。',
      parameters: {
        resource: { type: 'string', required: true, description: '集合名，如 sales-orders' },
        id: { type: 'string', required: true, description: '记录编号' },
        show: SHOW_PARAMETER,
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        const id = String(exec.agent.id)
        // The same for a record: one opened beside an answer does not replace another the person has open.
        if (args.show !== true && hasOpen(pane, id, String(args.id)))
          return JSON.stringify({ opened: false, notice: OPEN_KEEPS_PAGE })
        const result = await pane.openRecord(
          id,
          String(args.resource),
          String(args.id),
          exec.signal,
          args.show === true,
        )
        return JSON.stringify(result.opened ? { opened: true, ...currentPage(pane, id) } : result)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_list_filter',
      description:
        '筛选中间栏当前的列表（待办）：按关键词、状态、日期范围缩小页面上已载入的记录。传的就是筛选条件的全部，没传的条件会被清除；都不传即清除筛选。status 用接口里的原值（如 open、completed）。当前的条件在 oryh_current_page 的 context.listFilter 里。菜单里的销售订单、库存、收发货列表用 oryh_record_query。只改页面显示，不改数据。',
      parameters: {
        text: { type: 'string', description: '关键词，匹配标题等文字' },
        status: { type: 'string', description: '状态原值，如 open' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        return filterList(pane, String(exec.agent.id), args, exec.signal)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_navigate',
      description:
        '按用户意图在中间栏打开业务页面，等待页面回执。只导航；页面数据仍可能加载中。没有打开的业务页面时会直接说明。',
      parameters: { page: { type: 'string', required: true, enum: pageIds() }, show: SHOW_PARAMETER },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        return navigate(pane, String(exec.agent.id), args.page as PageId, exec.signal, args.show === true)
      },
    }),
  )
}
