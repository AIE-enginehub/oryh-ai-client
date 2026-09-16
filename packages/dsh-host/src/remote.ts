import type {OryhRecordRemote,RecordQuery,RecordPage,ProductSearch,ProductOptions,RecordFilterField} from '@oryh/ai-client-records'
import type {OryhProjectRemote,ProjectIntent,ProjectOptions} from '@oryh/ai-client-projects'
import type {ProjectPrepareRequest,ProjectChatState} from './types.js'
import type { ChatPageRequest, ChatHomeRequest, CommandFrame } from './types.js'
import type { TimesheetChatState } from './types.js'
import type { BusinessChat } from './business-chat.js'
import type { TodoDetailService, TodoDocument } from '@oryh/ai-client-todos'
import type { ChatSelection, ChatContextView } from './types.js'
import type { TodoDetailRequest, ChatClearRequest } from './types.js'
import type { OryhTimesheetRemote, TimesheetHeader, TimesheetTodo, TimesheetOptions, TimesheetDetail, TimesheetIntent } from '@oryh/ai-client-timesheets'
import type { TimesheetDetailRequest, TimesheetActionRequest } from './types.js'
import { OryhClientRemoteAdapter } from '@oryh/ai-client-core'
import type { OryhSkillService, SkillRefreshResult } from '@oryh/ai-client-core'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BeginConnectionView, ConnectionSummary, OryhClientController, OryhOperationResult,
  OperationDefinition, OperationId, PollConnectionView, SavedOperationView,
} from '@oryh/ai-client-core'
import type { ConnectionId, DeviceAuthorizationId, OperationResultId, SavedOperationId } from '@oryh/ai-client-foundation'
import type { ExpenseDraft, ExpenseFields, OryhExpenseRemote } from '@oryh/ai-client-expenses'

import type { ConnectRequest, ConnectionRequest, AuthorizationRequest, OperationRequest, ResultRequest, SaveResultRequest, SavedRequest, DraftRequest, SaveDraftRequest, ConfirmDraftRequest, ConfirmTimesheetRequest, UploadRequest, ExpenseOptions, AttachmentReceipt } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhRecords:OryhRecordRemote
    oryhProjects:OryhProjectRemote
    oryhChat: BusinessChat
    oryhTodoDetails: TodoDetailService
    oryhSkills: OryhSkillService
    oryhAbort: () => void
    oryhClient: OryhClientController
    oryhTimesheets: OryhTimesheetRemote
    oryhExpenses: OryhExpenseRemote
    oryhRemote: OryhRemote
  }
}

/** Browser-only typed business API; no member is registered as an Agent tool. */
export class OryhRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhClient', 'oryhExpenses', 'oryhTimesheets', 'oryhProjects', 'oryhRecords', 'oryhTodoDetails', 'oryhChat', 'oryhAbort', 'agents', 'oryhSkills']
  private readonly api: OryhClientRemoteAdapter
  private closed = false
  private readonly active = new Set<Promise<unknown>>()
  constructor(ctx: Context) {
    super(ctx, 'oryhRemote', { namespace: 'oryh' })
    this.api = new OryhClientRemoteAdapter(ctx.oryhClient)
    const abort = ctx.oryhAbort
    ctx.effect(() => async () => {
      this.closed = true
      abort()
      await Promise.allSettled([...this.active])
    }, 'oryh pending requests')
  }
  /** Public deployment hint only; credentials never cross this Remote. */
  @Remote('connectionDefaults') connectionDefaults(): { origin: string } {
    const value = process.env.ORYH_SERVER_ORIGIN?.trim()
    if (!value) return { origin: '' }
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('ORYH_SERVER_ORIGIN must be an HTTP(S) origin without credentials or a path')
    }
    return { origin: url.origin }
  }
  @Remote('listConnections') listConnections(): Promise<readonly ConnectionSummary[]> { return this.call(() => this.ctx.oryhClient.listConnections()) }
  @Remote('beginConnection') beginConnection(request: ConnectRequest): Promise<BeginConnectionView> { return this.call(() => this.ctx.oryhClient.beginConnection(request.origin, request.clientName)) }
  @Remote('pollConnection') pollConnection(request: AuthorizationRequest): Promise<PollConnectionView> { return this.call(() => this.ctx.oryhClient.pollConnection(request.authorizationId)) }
  @Remote('cancelConnection') cancelConnection(request: AuthorizationRequest): Promise<void> { return this.call(() => this.ctx.oryhClient.cancelConnection(request.authorizationId)) }
  @Remote('verifyConnection') verifyConnection(request: ConnectionRequest): Promise<ConnectionSummary> { return this.call(() => this.ctx.oryhClient.verifyConnection(request.connectionId)) }
  @Remote('listOperations') listOperations(): Promise<readonly OperationDefinition[]> { return this.call(() => this.ctx.oryhClient.listOperations()) }
  @Remote('execute') execute(request: OperationRequest): Promise<OryhOperationResult> { return this.call(() => this.api.execute(request.connectionId, request.operationId)) }
  @Remote('reuse') reuse(request: ResultRequest): Promise<OryhOperationResult> { return this.call(() => this.api.reuse(request.connectionId, request.operationId, request.resultId)) }
  @Remote('saveResult') saveResult(request: SaveResultRequest): Promise<SavedOperationView> { return this.call(() => this.ctx.oryhClient.saveResult(request.connectionId, request.operationId, request.resultId, request.label)) }
  @Remote('listSavedOperations') listSavedOperations(request: ConnectionRequest): Promise<readonly SavedOperationView[]> { return this.call(() => this.ctx.oryhClient.listSavedOperations(request.connectionId)) }
  @Remote('refreshSavedOperation') refreshSavedOperation(request: SavedRequest): Promise<OryhOperationResult> { return this.call(() => this.ctx.oryhClient.refreshSavedOperation(request.connectionId, request.savedOperationId)) }
  @Remote('disconnect') disconnect(request: ConnectionRequest): Promise<void> { return this.call(() => this.ctx.oryhClient.disconnect(request.connectionId)) }
  @Remote('expenseList') expenseList(request: ConnectionRequest): Promise<ExpenseDraft[]> { return this.call(() => this.ctx.oryhExpenses.expenseList(request.connectionId)) }
  @Remote('expenseOptions') expenseOptions(request: ConnectionRequest): Promise<ExpenseOptions> { return this.call(() => this.ctx.oryhExpenses.expenseOptions(request.connectionId)) }
  @Remote('expenseSave') expenseSave(request: SaveDraftRequest): Promise<ExpenseDraft> { return this.call(() => this.ctx.oryhExpenses.expenseSave(request.connectionId, request)) }
  @Remote('expensePrepare') expensePrepare(request: DraftRequest): Promise<ExpenseDraft> { return this.call(() => this.ctx.oryhExpenses.expensePrepare(request.connectionId, request.id, request.revision)) }
  @Remote('expenseConfirm') expenseConfirm(request: ConfirmTimesheetRequest): Promise<ExpenseDraft> { return this.call(() => this.ctx.oryhExpenses.expenseConfirm(request.connectionId, request.id, request.revision, request.token, request.sessionId)) }
  @Remote('expenseReconcile') expenseReconcile(request: DraftRequest): Promise<ExpenseDraft> { return this.call(() => this.ctx.oryhExpenses.expenseReconcile(request.connectionId, request.id, request.revision)) }
  @Remote('expenseUpload') expenseUpload(request: UploadRequest): Promise<AttachmentReceipt> { return this.call(() => this.ctx.oryhExpenses.expenseUpload(request.connectionId, request)) }
  @Remote('expenseArchive') expenseArchive(request: DraftRequest): Promise<void> { return this.call(() => this.ctx.oryhExpenses.expenseDelete(request.connectionId, request.id, request.revision)) }
  @Remote('timesheetList') timesheetList(request: ConnectionRequest): Promise<TimesheetHeader[]> { return this.call(() => this.ctx.oryhTimesheets.timesheetList(request.connectionId)) }
  @Remote('timesheetQueue') timesheetQueue(request: ConnectionRequest): Promise<TimesheetTodo[]> { return this.call(() => this.ctx.oryhTimesheets.timesheetQueue(request.connectionId)) }
  @Remote('timesheetOptions') timesheetOptions(request: ConnectionRequest): Promise<TimesheetOptions> { return this.call(() => this.ctx.oryhTimesheets.timesheetOptions(request.connectionId)) }
  @Remote('timesheetDetail') timesheetDetail(request: TimesheetDetailRequest): Promise<TimesheetDetail> { return this.call(() => this.ctx.oryhTimesheets.timesheetDetail(request.connectionId, request.headerId, request.todoId)) }
  @Remote('timesheetHistory') timesheetHistory(request: ConnectionRequest): Promise<TimesheetIntent[]> { return this.call(() => this.ctx.oryhTimesheets.timesheetHistory(request.connectionId)) }
  @Remote('timesheetPrepare') timesheetPrepare(request: TimesheetActionRequest): Promise<TimesheetIntent> { return this.call(() => this.ctx.oryhTimesheets.timesheetPrepare(request.connectionId, request.action)) }
  @Remote('timesheetConfirm') timesheetConfirm(request: ConfirmTimesheetRequest): Promise<TimesheetIntent> { return this.call(() => this.ctx.oryhTimesheets.timesheetConfirm(request.connectionId, request.id, request.revision, request.token, request.sessionId)) }
  @Remote('timesheetReconcile') timesheetReconcile(request: DraftRequest): Promise<TimesheetIntent> { return this.call(() => this.ctx.oryhTimesheets.timesheetReconcile(request.connectionId, request.id, request.revision)) }
  @Remote('todoDetail') todoDetail(request: TodoDetailRequest): Promise<TodoDocument> { return this.call(() => this.ctx.oryhTodoDetails.read(request.connectionId, request.todoId)) }
  @Remote('chatSelect') chatSelect(request: ChatSelection): Promise<ChatContextView> { return this.call(() => this.ctx.oryhChat.select(request)) }
  @Remote('chatClear') chatClear(request: ChatClearRequest): Promise<void> { return this.call(() => this.ctx.oryhChat.clear(request.sessionId)) }
  /** Refresh the authorized skill source for this connection. */
  @Remote('skillSync') skillSync(request: ConnectionRequest & { force?: boolean }): Promise<SkillRefreshResult> { return this.call(() => this.ctx.oryhSkills.sync(request.connectionId, request.force === true)) }
  @Remote('timesheetChatSync') timesheetChatSync(request: TimesheetChatState): Promise<void> { return this.call(() => this.ctx.oryhChat.timesheet.sync(request)) }
  /** Start the pre-submit norm review; it returns at once and reports over the command stream. */
  @Remote('timesheetReviewStart') timesheetReviewStart(request: { sessionId: string; headerId: string }): Promise<void> { return this.call(() => this.ctx.oryhChat.timesheet.reviewStart(request.sessionId, request.headerId)) }
  @Remote('expenseReviewStart') expenseReviewStart(request: { sessionId: string; draftId: string }): Promise<void> { return this.call(async () => { this.ctx.oryhChat.expenseReviewStart(request.sessionId, request.draftId) }) }
  /** Drop the review when the user skips it or the submission settles. */
  @Remote('reviewClear') reviewClear(request: { sessionId: string }): Promise<void> { return this.call(async () => { this.ctx.oryhChat.reviews.clear(request.sessionId) }) }
  @Remote('productSearch') productSearch(r:ProductSearch):Promise<ProductOptions>{return this.call(()=>this.ctx.oryhRecords.productSearch(r))}
  @Remote('recordList') recordList(r:RecordQuery):Promise<RecordPage>{return this.call(()=>this.ctx.oryhRecords.recordList(r))}
  @Remote('recordFilterFields') recordFilterFields(r:{connectionId:string;kind:RecordQuery['kind']}):Promise<RecordFilterField[]>{return this.call(()=>this.ctx.oryhRecords.recordFilterFields(r.connectionId,r.kind))}
  @Remote('projectOptions') projectOptions(r:ConnectionRequest):Promise<ProjectOptions>{return this.call(()=>this.ctx.oryhProjects.projectOptions(r.connectionId))}
  @Remote('projectPrepare') projectPrepare(r:ProjectPrepareRequest):Promise<ProjectIntent>{return this.call(()=>this.ctx.oryhProjects.projectPrepare(r.connectionId,r.fields))}
  @Remote('projectConfirm') projectConfirm(r:ConfirmDraftRequest):Promise<ProjectIntent>{return this.call(()=>this.ctx.oryhProjects.projectConfirm(r.connectionId,r.id,r.revision,r.token))}
  @Remote('projectHistory') projectHistory(r:ConnectionRequest):Promise<ProjectIntent[]>{return this.call(()=>this.ctx.oryhProjects.projectHistory(r.connectionId))}
  @Remote('projectReconcile') projectReconcile(r:DraftRequest):Promise<ProjectIntent>{return this.call(()=>this.ctx.oryhProjects.projectReconcile(r.connectionId,r.id,r.revision))}
  @Remote('projectChatSync') projectChatSync(r:ProjectChatState):Promise<void>{return this.call(()=>this.ctx.oryhChat.project.sync(r))}
  @Remote('projectChatClear') projectChatClear(r:ChatClearRequest):Promise<void>{return this.call(()=>this.ctx.oryhChat.project.clear(r.sessionId))}
  @Remote('chatPageSync') chatPageSync(request:ChatPageRequest):Promise<void>{return this.call(()=>this.ctx.oryhChat.pageSync(request))}
  // Streams carry their own failures; the unary `call` wrapper would swallow the iterator.
  @Remote({mode:'stream'}) commands(request:ChatHomeRequest,signal:AbortSignal):AsyncIterable<CommandFrame>{return this.ctx.oryhChat.commands(request,signal)}
  @Remote('chatHomeClear') chatHomeClear(request:ChatClearRequest):Promise<void>{return this.call(()=>this.ctx.oryhChat.homeClear(request.sessionId))}
  private async call<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new RemoteError('oryh/business', 'ORYH 插件已卸载。', { code: 'request-failed' })
    const pending = Promise.resolve().then(action)
    this.active.add(pending)
    try { return await pending } catch (error) {
      if (error instanceof OryhClientError) throw new RemoteError('oryh/business', error.message, { code: error.code })
      throw new RemoteError('oryh/business', 'ORYH 无法完成请求，请重试。', { code: 'request-failed' })
    } finally { this.active.delete(pending) }
  }

}
