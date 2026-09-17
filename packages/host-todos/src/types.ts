import type { ConnectionId } from '@oryh/ai-client-foundation'

export type { TodoDocument } from '@oryh/ai-client-todos'
// Request shapes name the connection themselves: a base from another package is one the typert
// generator does not resolve.
export interface TodoDetailRequest {
  connectionId: ConnectionId
  todoId: string
}
