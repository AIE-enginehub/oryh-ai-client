import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ExpenseDraft, OryhExpenseRemote } from '@oryh/ai-client-expenses'
import { RemoteCalls } from '@oryh/dsh-connection'
import type {
  AttachmentReceipt,
  ConfirmExpenseRequest,
  ConnectionRequest,
  DraftRequest,
  ExpenseOptions,
  ExpenseReviewStartRequest,
  SaveDraftRequest,
  UploadRequest,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhExpenses: OryhExpenseRemote
    /** Ask the agent to check an expense claim against the enterprise norms before the page submits it. */
    oryhExpenseReview: (sessionId: string, draftId: string) => void
    oryhExpensesRemote: ExpensesRemote
  }
}

/** Browser-only expense API; drafts are the page's, confirmation stays outside model tools. */
export class ExpensesRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhExpenses', 'oryhExpenseReview']
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhExpensesRemote', { namespace: 'oryhExpenses' })
    this.calls = new RemoteCalls(ctx, 'oryhExpenses')
  }
  @Remote('expenseList') expenseList(request: ConnectionRequest): Promise<ExpenseDraft[]> {
    return this.calls.call(() => this.ctx.oryhExpenses.expenseList(request.connectionId))
  }
  @Remote('expenseOptions') expenseOptions(request: ConnectionRequest): Promise<ExpenseOptions> {
    return this.calls.call(() => this.ctx.oryhExpenses.expenseOptions(request.connectionId))
  }
  @Remote('expenseSave') expenseSave(request: SaveDraftRequest): Promise<ExpenseDraft> {
    return this.calls.call(() => this.ctx.oryhExpenses.expenseSave(request.connectionId, request))
  }
  @Remote('expensePrepare') expensePrepare(request: DraftRequest): Promise<ExpenseDraft> {
    return this.calls.call(() =>
      this.ctx.oryhExpenses.expensePrepare(request.connectionId, request.id, request.revision),
    )
  }
  @Remote('expenseConfirm') expenseConfirm(request: ConfirmExpenseRequest): Promise<ExpenseDraft> {
    return this.calls.call(() =>
      this.ctx.oryhExpenses.expenseConfirm(
        request.connectionId,
        request.id,
        request.revision,
        request.token,
        request.sessionId,
      ),
    )
  }
  @Remote('expenseReconcile') expenseReconcile(request: DraftRequest): Promise<ExpenseDraft> {
    return this.calls.call(() =>
      this.ctx.oryhExpenses.expenseReconcile(request.connectionId, request.id, request.revision),
    )
  }
  @Remote('expenseUpload') expenseUpload(request: UploadRequest): Promise<AttachmentReceipt> {
    return this.calls.call(() => this.ctx.oryhExpenses.expenseUpload(request.connectionId, request))
  }
  @Remote('expenseArchive') expenseArchive(request: DraftRequest): Promise<void> {
    return this.calls.call(() =>
      this.ctx.oryhExpenses.expenseDelete(request.connectionId, request.id, request.revision),
    )
  }
  @Remote('expenseReviewStart') expenseReviewStart(request: ExpenseReviewStartRequest): Promise<void> {
    return this.calls.call(async () => {
      this.ctx.oryhExpenseReview(request.sessionId, request.draftId)
    })
  }
}
