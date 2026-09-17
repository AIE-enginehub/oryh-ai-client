import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { TodoDocument } from '@oryh/ai-client-todos'
import { connectionRequest, unwrap } from '@oryh/dsh-client-frame/client'
import type {} from '@oryh/dsh-todos/remote'
import { createContext, useContext } from 'react'

/** The todos namespace (`oryhTodos`), as the page calls it. */
export interface TodosApi {
  todoDetail(connectionId: string, todoId: string): Promise<TodoDocument>
}
export const TodosApiContext = createContext<TodosApi | undefined>(undefined)
export function useTodosApi(): TodosApi {
  const api = useContext(TodosApiContext)
  if (!api) throw new Error('ORYH todos Remote is not mounted')
  return api
}
export function createTodosApi(remote: ClientRemote): TodosApi {
  const todos = remote.oryhTodos
  return { todoDetail: (id, todoId) => unwrap(todos.todoDetail({ ...connectionRequest(id), todoId })) }
}
