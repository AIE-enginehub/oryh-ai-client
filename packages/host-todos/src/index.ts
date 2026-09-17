/** Todos as a Harness Host plugin: the linked-document read, and the pane tools over the todo list. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@oryh/dsh-connection'
import type {} from '@oryh/dsh-pane'
import { TodosRemote } from './remote.js'
import { TodoChat } from './todo-chat.js'

export { TodosRemote } from './remote.js'
export { TodoChat } from './todo-chat.js'

export const name = 'oryh-todos'
export const inject = ['typert', 'tools', 'oryhHost', 'oryhPane']

/** The rule the agent follows for the todo list; page names and tool names are its own. */
export const TODO_RULES: readonly string[] = [
  '待办：用户在待办列表说查看第一条、第二条或指定标题的待办时，先调用 oryh_visible_todos 按当前可见顺序定位，再调用 oryh_open_todo 传 position 和 revision 在中间栏打开并读取详情；列表版本变化就重新读取，标题有歧义先询问。回答当前待办或关联单据的具体信息时调用 oryh_current_todo_details 获取服务端最新数据，引用实际单据类型、编号和查询时间。',
]
export const TODO_TOOLS: readonly string[] = ['oryh_current_todo_details', 'oryh_visible_todos', 'oryh_open_todo']

export function apply(ctx: Context): void {
  const details = ctx.oryhHost.createTodoDetailRemote()
  ctx.provide('oryhTodoDetails', details)
  new TodoChat(ctx, ctx.oryhPane, details).install()
  ctx.effect(
    () =>
      ctx.oryhPane.contribute({ name, resources: { todos: 'my-open-todos' }, prompt: TODO_RULES, tools: TODO_TOOLS }),
    'oryh todos contribution',
  )
  ctx.plugin(TodosRemote)
}
