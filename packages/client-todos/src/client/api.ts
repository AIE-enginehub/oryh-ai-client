import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { connectionRequest, unwrap } from '@oryh/ai-client-kit'
import type { TodoDocument } from '@oryh/ai-client-todos'
import type {} from '@oryh/dsh-todos/remote'

/** The todos namespace (`oryhTodos`), as the page calls it. */
export interface TodosApi {
  todoDetail(connectionId: string, todoId: string): Promise<TodoDocument>
}
export function createTodosApi(remote: ClientRemote): TodosApi {
  const todos = remote.oryhTodos
  return { todoDetail: (id, todoId) => unwrap(todos.todoDetail({ ...connectionRequest(id), todoId })) }
}
