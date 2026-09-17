import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteCalls } from '@oryh/dsh-connection'
import type { PaneService } from './service.js'
import type { SubmitReview } from './submit-review.js'
import type {
  PaneBindRequest,
  PaneBindView,
  PaneFrame,
  PaneSync,
  PaneUnbindRequest,
  ReviewClearRequest,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhPane: PaneService
    oryhReview: SubmitReview
    oryhPaneRemote: PaneRemote
  }
}

/** The pane's side of the bridge, for the browser: bind, report, follow. */
export class PaneRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhPane', 'oryhReview']
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
  // Streams carry their own failures; the unary `call` wrapper would swallow the iterator.
  @Remote({ mode: 'stream' }) paneCommands(request: PaneBindRequest, signal: AbortSignal): AsyncIterable<PaneFrame> {
    return this.ctx.oryhPane.commands(request, signal)
  }
  /** Drop the review when the user skips it or the submission settles. */
  @Remote('reviewClear') reviewClear(request: ReviewClearRequest): Promise<void> {
    return this.calls.call(async () => {
      this.ctx.oryhReview.clear(request.sessionId)
    })
  }
}
