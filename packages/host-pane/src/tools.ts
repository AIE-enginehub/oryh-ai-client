import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { type PageId, pageById, pageIds, requirePage } from '@oryh/ai-client-pages'
import { NAVIGATION_WITHOUT_PANE, NO_PAGE } from './notices.js'
import type { PaneService } from './service.js'
import type { PaneContext } from './types.js'

/** The shape of a tool that answers with text. */
export const textOutput = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** The generic part of a page's context: what every page reports, without the page-specific sections. */
function genericContext(context: PaneContext | undefined) {
  if (context === undefined) return undefined
  const { todos: _todos, timesheet: _timesheet, project: _project, ...generic } = context
  return generic
}

/** What the page shows, for the model, in the shape each page's tools read. */
function visible(page: PageId, context: PaneContext | undefined, revision: number) {
  if (context === undefined) return undefined
  if (page === 'list-projects' && context.project)
    return { kind: 'project-form', revision, fields: context.project.fields, busy: context.project.busy, unsaved: true }
  if ((page === 'timesheets' || page === 'timesheet-approvals') && context.timesheet) {
    const ts = context.timesheet
    if (ts.manager !== (page === 'timesheet-approvals')) return undefined
    return {
      kind: ts.fields ? 'timesheet-form' : 'timesheet-detail',
      revision,
      headerId: ts.headerId,
      fields: ts.fields,
      localEdits: ts.localEdits,
    }
  }
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
  if (page === 'list-projects')
    return {
      read: true,
      create: true,
      update: false,
      notice:
        '用户正在填新建项目表单时，可用 oryh_project_read / oryh_project_fill 帮着填；在对话里创建项目按对应的 skill 执行，创建权限由服务端判断。',
    }
  if (page === 'my-expense-claims')
    return { notice: '页面上的本地草稿是页面功能；在对话里创建或提交费用，按费用 skill 使用服务端的费用单。' }
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
    userMenu: pane.menu(sessionId).map(({ id, label, kind, filters }) => ({ id, label, kind, filters })),
    visible: visible(session.page, context, session.revision),
    capabilities: capabilities(session.page),
    instruction: '这是当前界面，不以聊天历史中的旧页面为准。',
  }
}

/**
 * Open a page in the business pane and wait for it to show.
 *
 * The pane may not be open at all, which is exactly when navigating is worth trying: reading the
 * current page first would refuse the one case this tool exists for. Nothing answering then is a
 * fact to report, not a failure of the request.
 */
export async function navigate(pane: PaneService, sessionId: string, page: PageId, signal: AbortSignal) {
  const home = pane.home(sessionId)
  const before = pane.session(sessionId)?.page !== undefined ? currentPage(pane, sessionId) : undefined
  const { connection } = await pane.verified(sessionId)
  requirePage(connection.identity, page)
  if (before?.page === page) return JSON.stringify(before)
  try {
    return await pane.issue<string>(
      sessionId,
      // With no pane open there is nobody to answer, so that case is not worth a long wait.
      { lane: 'navigation', page, payload: { target: 'page', page }, timeoutMs: before ? 15_000 : 4_000 },
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

/** The tools the pane itself offers, named for the agent's allow-list. */
export const PANE_TOOLS: readonly string[] = ['oryh_current_page', 'oryh_navigate']

/** Register the page tools every page shares: what is showing, and going somewhere else. */
export function installPaneTools(ctx: Context, pane: PaneService): void {
  ctx.tools.register(
    defineTool({
      name: 'oryh_current_page',
      description:
        '读取中间栏当前页面的列表、详情或表单上下文，以及用户自建的菜单项。用户提到“这个”“当前单据”或需要页面上的数据时调用；页面切换后以此为准，不沿用历史页面。没有打开的页面时返回 page 为空。',
      parameters: {},
      output: textOutput,
      execute: async (_args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        const id = String(exec.agent.id)
        if (pane.session(id)?.page === undefined) return JSON.stringify({ page: null, notice: NO_PAGE })
        await pane.refreshMenu(id).catch(() => {})
        return JSON.stringify(currentPage(pane, id))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_navigate',
      description:
        '按用户意图在中间栏打开业务页面，等待页面回执。只导航；页面数据仍可能加载中。没有打开的业务页面时会直接说明。',
      parameters: { page: { type: 'string', required: true, enum: pageIds() } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        return navigate(pane, String(exec.agent.id), args.page as PageId, exec.signal)
      },
    }),
  )
}
