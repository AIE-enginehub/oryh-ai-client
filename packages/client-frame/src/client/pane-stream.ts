/** The pane stream as the browser follows it: Harness's supervision mapped onto published pane state. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// Values, not types: reachable because the gateway is declared external and answered by the
// loader module table. See docs/14, "跨插件值引用".
import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { PaneStreamHandle, PaneStreamState } from '@oryh/ai-client-kit'
import type { PaneBindRequest, PaneFrame } from '@oryh/dsh-pane/types'

const streamName = 'ORYH pane stream'

/** Text to publish for a terminal stream failure. */
function failureMessage(error: unknown, broken: () => string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : broken()
}

/**
 * Follow one session's pane over the generated stream Remote.
 *
 * Built on Harness's own supervision rather than a hand-rolled loop: `$stream` is a service
 * method, so Connection owns the retry timing and only a `RemoteStreamCarrierError` reopens —
 * every other failure is terminal. `RemoteSnapshotStream` adds the baseline-then-deltas
 * protocol, including the single-baseline-per-generation check, and keeps the previous frame
 * published while the carrier retries.
 *
 * Every frame carries the whole set, so a reopen republishes a baseline and no command is
 * replayed or lost.
 * @param remote - client Remote carrying the mounted ORYH namespace.
 * @param request - the session and connection to follow.
 * @param broken - what to say of a stream that failed without saying why.
 * @returns an unstarted store owned by the caller.
 */
export function createPaneStream(
  remote: ClientRemote,
  request: PaneBindRequest,
  broken: () => string,
): PaneStreamHandle {
  let state: PaneStreamState = { commands: [], state: {}, status: 'connecting' }
  const listeners = new Set<() => void>()
  const publish = (next: PaneStreamState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const stream = remote.$stream<PaneFrame>({
    name: streamName,
    open: signal => remote.oryhPane.paneCommands(request, signal) as AsyncIterable<PaneFrame>,
    // A normal end after a baseline means the Host dropped the binding. Marking it retryable
    // spends one reopen to surface the Host's actual reason rather than inventing one here;
    // that reopen is refused as a business error and becomes terminal with the real message.
    // Ending before any baseline breaks the Host's own contract, so it stays terminal at once.
    ended: accepted =>
      accepted
        ? new RemoteStreamCarrierError(`${streamName} was closed by the Host`)
        : new Error(`${streamName} closed before its opening snapshot`),
    carrierFailed: () => {
      publish({ ...state, status: 'reconnecting' })
    },
  })
  const snapshots = new RemoteSnapshotStream<PaneFrame, PaneFrame>(stream, {
    name: streamName,
    isSnapshot: (frame): frame is PaneFrame => frame.type === 'baseline',
    replace: baseline => {
      publish({ commands: baseline.commands, state: baseline.state, status: 'synced' })
    },
    update: delta => {
      publish({ commands: delta.commands, state: delta.state, status: 'synced' })
    },
    // The pending set is dropped on a terminal failure instead of staying published: a command
    // is an instruction for the page, and acting on a stale one after the stream died is wrong.
    failed: error => {
      publish({ commands: [], state: {}, status: 'rejected', error: failureMessage(error, broken) })
    },
  })
  return {
    getSnapshot: () => state,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: () => {
      snapshots.start()
    },
    dispose: () => snapshots.dispose(),
  }
}
