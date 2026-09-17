import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { TodoDetailService, TodoDocument } from '@oryh/ai-client-todos'
import { type PaneService, textOutput } from '@oryh/dsh-pane'

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/**
 * The todo list in the business pane, for the agent: the order the person sees, opening one by that
 * order, and the linked document of the one that is open.
 *
 * Identity and target come from the pane, never from the model: a tool takes a position in the
 * visible list or nothing at all, and every read is the same server read a click makes.
 */
export class TodoChat {
  constructor(
    private readonly ctx: Context,
    private readonly pane: PaneService,
    private readonly details: TodoDetailService,
  ) {}

  /** The visible todo list, in the pane's order, as the agent must refer to it. */
  private list(sessionId: string) {
    const session = this.pane.session(sessionId)
    const todos = session?.page === 'my-open-todos' ? session.context?.todos : undefined
    if (!session || !todos?.listRevision) throw fail('当前没有已同步的待办列表。请保持待办列表打开并等待加载完成。')
    return { session, todos }
  }

  async visibleTodos(sessionId: string) {
    const { session, todos } = this.list(sessionId)
    await this.pane.verified(sessionId)
    this.pane.assertUnchanged(sessionId, session, '企业或列表已改变，请重新读取。')
    return {
      revision: todos.listRevision,
      items: todos.visibleTodos.map((todo, index) => ({ position: index + 1, ...todo })),
      notice: '序号对应中间栏当前页经过筛选和排序后的显示顺序，不是全部待办的服务端顺序。',
    }
  }

  /** Open the todo at a visible position, once the pane shows it; returns its linked document. */
  async openTodo(sessionId: string, position: number, revision: string, signal: AbortSignal): Promise<TodoDocument> {
    const { session, todos } = this.list(sessionId)
    if (todos.listRevision !== revision) throw fail('列表已改变，请重新读取当前可见待办。')
    if (!Number.isSafeInteger(position) || position < 1 || position > todos.visibleTodos.length)
      throw fail('当前页没有这个序号的待办。')
    const target = todos.visibleTodos[position - 1]!
    await this.pane.verified(sessionId)
    // Validate ownership against the same read operation used by a traditional UI click.
    const document = await this.details.read(session.connectionId, target.id)
    this.pane.assertUnchanged(sessionId, session, '列表已改变，请重新读取。')
    return this.pane.issue<TodoDocument>(
      sessionId,
      {
        lane: 'navigation',
        page: 'my-open-todos',
        payload: { target: 'todo', page: 'my-open-todos', todoId: target.id, listRevision: revision },
        timeoutMs: 15_000,
      },
      id => ({
        until: () =>
          this.pane.acked(sessionId, id) && this.pane.session(sessionId)?.context?.todos?.todoId === target.id
            ? document
            : undefined,
        expired: '待办详情未能打开，列表可能已更新或页面已切换，请重新读取后重试。',
        signal,
      }),
    )
  }

  /** The linked document of the todo open in the pane, read from the server now. */
  async read(sessionId: string): Promise<TodoDocument> {
    const session = this.pane.session(sessionId)
    const todoId = session?.page === 'my-open-todos' ? session.context?.todos?.todoId : undefined
    if (!session || !todoId) throw fail('尚未同步当前待办。请打开待办并等待“Chat 已关联”提示。')
    await this.pane.verified(sessionId)
    const result = await this.details.read(session.connectionId, todoId)
    if (this.pane.session(sessionId)?.context?.todos?.todoId !== todoId)
      throw fail('当前页面已改变，本次查询已取消，请重新同步。')
    return result
  }

  install(): void {
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_visible_todos',
        description:
          '读取中间栏待办列表当前页的可见顺序、标题和版本。用户说第一条、第二条或某标题时先调用此工具；无需手动选中。',
        parameters: {},
        output: textOutput,
        execute: async (_args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return JSON.stringify(await this.visibleTodos(String(exec.agent.id)))
        },
      }),
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_open_todo',
        description:
          '按刚读取的可见列表序号在中间栏打开待办详情，并返回关联业务单据的最新详情。序号从 1 开始；列表变化则拒绝。只打开和读取；审批按审批 skill 在对话里完成。',
        parameters: {
          position: { type: 'integer', required: true, description: '当前可见页序号，从 1 开始' },
          revision: { type: 'string', required: true, description: 'oryh_visible_todos 返回的列表版本' },
        },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return JSON.stringify(await this.openTodo(String(exec.agent.id), args.position, args.revision, exec.signal))
        },
      }),
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_current_todo_details',
        description:
          '只读查询当前会话关联的 ORYH 待办及其采购申请、采购订单、销售报价、销售订单、工时或费用单据详情。身份和目标由 Host 绑定，不接受编号、URL 或员工参数。',
        parameters: {},
        output: textOutput,
        execute: async (_args, exec) => {
          if (!exec.agent) throw new Error('需要绑定的 ORYH 会话')
          exec.signal.throwIfAborted()
          const result = await this.read(String(exec.agent.id))
          exec.signal.throwIfAborted()
          return JSON.stringify(result)
        },
      }),
    )
  }
}
