import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TodoDetailService, TodoDocument } from '@oryh/ai-client-todos'
import { RemoteCalls } from '@oryh/dsh-connection'
import type { TodoDetailRequest } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhTodoDetails: TodoDetailService
    oryhTodosRemote: TodosRemote
  }
}

/** Browser-only todo API: the linked document of one todo, read as the model's tool reads it. */
export class TodosRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhTodoDetails']
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhTodosRemote', { namespace: 'oryhTodos' })
    this.calls = new RemoteCalls(ctx, 'oryhTodos')
  }
  @Remote('todoDetail') todoDetail(request: TodoDetailRequest): Promise<TodoDocument> {
    return this.calls.call(() => this.ctx.oryhTodoDetails.read(request.connectionId, request.todoId))
  }
}
