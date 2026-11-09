import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { RemoteCalls } from '@oryh/dsh-connection'
import type { PaneService } from './service.js'
import type { SharedViews } from './shared-views.js'
import type { SubmitReview } from './submit-review.js'
import type {
  PaneAskRequest,
  PaneBindRequest,
  PaneBindView,
  PaneCopiedView,
  PaneCopySharedViewRequest,
  PaneFrame,
  PaneMenuRequest,
  PaneOpenRecordRequest,
  PaneOpenRecordView,
  PaneShareViewRequest,
  PaneSync,
  PaneUnbindRequest,
  ReviewClearRequest,
  UserViewSummary,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhPane: PaneService
    oryhReview: SubmitReview
    /** Menu entries colleagues share with each other; it offers nothing where the deployment keeps no library. */
    oryhSharedViews: SharedViews
    oryhPaneRemote: PaneRemote
  }
}

/** The pane's side of the bridge, for the browser: bind, report, follow. */
export class PaneRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhPane', 'oryhReview', 'oryhSharedViews']
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhPaneRemote', { namespace: 'oryhPane' })
    this.calls = new RemoteCalls(ctx, 'oryhPane')
  }
  /** Bind the session to its enterprise; the pane speaks for it from then on. */
  @Remote('paneBind') paneBind(request: PaneBindRequest): Promise<PaneBindView> {
    return this.calls.call(() => this.ctx.oryhPane.bind(request))
  }
  @Remote('paneUnbind') paneUnbind(request: PaneUnbindRequest): Promise<void> {
    return this.calls.call(() => this.ctx.oryhPane.unbind(request.sessionId))
  }
  /** What the pane shows now; also the page's acknowledgement of the commands it carried out. */
  @Remote('paneSync') paneSync(request: PaneSync): Promise<void> {
    return this.calls.call(() => this.ctx.oryhPane.sync(request))
  }
  /** The menu a connection has before any session is open: what the person's role implies. */
  @Remote('paneMenu') paneMenu(request: PaneMenuRequest): Promise<UserViewSummary[]> {
    return this.calls.call(() => this.ctx.oryhPane.connectionMenu(request.connectionId))
  }
  // Streams carry their own failures; the unary `call` wrapper would swallow the iterator.
  @Remote({ mode: 'stream' }) paneCommands(request: PaneBindRequest, signal: AbortSignal): AsyncIterable<PaneFrame> {
    return this.ctx.oryhPane.commands(request, signal)
  }
  /** The person clicked a record's link in a Chat answer: show that record in the pane. */
  @Remote('paneOpenRecord') paneOpenRecord(request: PaneOpenRecordRequest): Promise<PaneOpenRecordView> {
    return this.calls.call(async () => {
      if (this.ctx.oryhPane.session(request.sessionId)?.connectionId !== request.connectionId)
        return { opened: false, notice: '会话尚未绑定企业。' }
      return this.ctx.oryhPane.showRecord(request.sessionId, request.type, request.id, AbortSignal.timeout(25_000))
    })
  }
  /** The person asked something from a page (「问 AI」): it goes to the session as their turn. */
  @Remote('paneAsk') paneAsk(request: PaneAskRequest): Promise<void> {
    return this.calls.call(async () => {
      if (this.ctx.oryhPane.session(request.sessionId)?.connectionId !== request.connectionId)
        throw new OryhClientError('会话尚未绑定企业。', 'request-failed')
      await this.ctx.oryhPane.ask(request.sessionId, request.question, request.subject)
    })
  }
  /** The person shared one of their own menu entries with their colleagues from its page, or stopped. */
  @Remote('paneShareView') paneShareView(request: PaneShareViewRequest): Promise<void> {
    return this.calls.call(async () => {
      if (this.ctx.oryhPane.session(request.sessionId)?.connectionId !== request.connectionId)
        throw new OryhClientError('会话尚未绑定企业。', 'request-failed')
      await this.ctx.oryhSharedViews.share(request.sessionId, request.userViewId, request.shared)
    })
  }
  /** The person took a copy of an entry a colleague shared; the copy is theirs, and is what comes back. */
  @Remote('paneCopySharedView') paneCopySharedView(request: PaneCopySharedViewRequest): Promise<PaneCopiedView> {
    return this.calls.call(async () => {
      if (this.ctx.oryhPane.session(request.sessionId)?.connectionId !== request.connectionId)
        throw new OryhClientError('会话尚未绑定企业。', 'request-failed')
      return this.ctx.oryhSharedViews.copy(request.sessionId, request.sharedViewId)
    })
  }
  /** Drop the review when the user skips it or the submission settles. */
  @Remote('reviewClear') reviewClear(request: ReviewClearRequest): Promise<void> {
    return this.calls.call(async () => {
      if (this.ctx.oryhPane.session(request.sessionId)?.connectionId !== request.connectionId)
        throw new OryhClientError('会话尚未绑定企业。', 'request-failed')
      this.ctx.oryhReview.clear(request.sessionId)
    })
  }
}
