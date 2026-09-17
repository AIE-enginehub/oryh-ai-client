import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  OryhTimesheetRemote,
  TimesheetDetail,
  TimesheetHeader,
  TimesheetIntent,
  TimesheetOptions,
  TimesheetTodo,
} from '@oryh/ai-client-timesheets'
import { RemoteCalls } from '@oryh/dsh-connection'
import type { TimesheetChat } from './timesheet-chat.js'
import type {
  ConfirmTimesheetRequest,
  ConnectionRequest,
  DraftRequest,
  TimesheetActionRequest,
  TimesheetDetailRequest,
  TimesheetReviewStartRequest,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhTimesheets: OryhTimesheetRemote
    oryhTimesheetChat: TimesheetChat
    oryhTimesheetsRemote: TimesheetsRemote
  }
}

/** Browser-only timesheet API; no member is registered as an Agent tool. */
export class TimesheetsRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhTimesheets', 'oryhTimesheetChat']
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhTimesheetsRemote', { namespace: 'oryhTimesheets' })
    this.calls = new RemoteCalls(ctx, 'oryhTimesheets')
  }
  @Remote('timesheetList') timesheetList(request: ConnectionRequest): Promise<TimesheetHeader[]> {
    return this.calls.call(() => this.ctx.oryhTimesheets.timesheetList(request.connectionId))
  }
  @Remote('timesheetQueue') timesheetQueue(request: ConnectionRequest): Promise<TimesheetTodo[]> {
    return this.calls.call(() => this.ctx.oryhTimesheets.timesheetQueue(request.connectionId))
  }
  @Remote('timesheetOptions') timesheetOptions(request: ConnectionRequest): Promise<TimesheetOptions> {
    return this.calls.call(() => this.ctx.oryhTimesheets.timesheetOptions(request.connectionId))
  }
  @Remote('timesheetDetail') timesheetDetail(request: TimesheetDetailRequest): Promise<TimesheetDetail> {
    return this.calls.call(() =>
      this.ctx.oryhTimesheets.timesheetDetail(request.connectionId, request.headerId, request.todoId),
    )
  }
  @Remote('timesheetHistory') timesheetHistory(request: ConnectionRequest): Promise<TimesheetIntent[]> {
    return this.calls.call(() => this.ctx.oryhTimesheets.timesheetHistory(request.connectionId))
  }
  @Remote('timesheetPrepare') timesheetPrepare(request: TimesheetActionRequest): Promise<TimesheetIntent> {
    return this.calls.call(() => this.ctx.oryhTimesheets.timesheetPrepare(request.connectionId, request.action))
  }
  @Remote('timesheetConfirm') timesheetConfirm(request: ConfirmTimesheetRequest): Promise<TimesheetIntent> {
    return this.calls.call(() =>
      this.ctx.oryhTimesheets.timesheetConfirm(
        request.connectionId,
        request.id,
        request.revision,
        request.token,
        request.sessionId,
      ),
    )
  }
  @Remote('timesheetReconcile') timesheetReconcile(request: DraftRequest): Promise<TimesheetIntent> {
    return this.calls.call(() =>
      this.ctx.oryhTimesheets.timesheetReconcile(request.connectionId, request.id, request.revision),
    )
  }
  /** Start the pre-submit norm review; it returns at once and reports over the pane stream. */
  @Remote('timesheetReviewStart') timesheetReviewStart(request: TimesheetReviewStartRequest): Promise<void> {
    return this.calls.call(() => this.ctx.oryhTimesheetChat.reviewStart(request.sessionId, request.headerId))
  }
}
