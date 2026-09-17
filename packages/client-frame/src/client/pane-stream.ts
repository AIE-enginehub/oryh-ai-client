/** The pane stream as the browser follows it: Harness's supervision mapped onto published pane state. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// Values, not types: reachable because the gateway is declared external and answered by the
// loader module table. See docs/14, "跨插件值引用".
import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { AnyPaneCommand, PaneBindRequest, PaneFrame, PaneState } from '@oryh/dsh-pane/types'

/**
 * Where the linkage stands, so a disconnect is never shown as a refusal.
 *
 * `idle` means no session is bound in this subtree at all; `reconnecting` keeps the last
 * frame published while the carrier retries; `rejected` is terminal and publishes none.
 */
export type PaneStatus = 'idle' | 'connecting' | 'synced' | 'reconnecting' | 'rejected'

/** Published pane state: the last full frame the Host sent, plus where the linkage stands. */
export interface PaneStreamState {
  /** Every command pending for the bound session. */
  readonly commands: readonly AnyPaneCommand[]
  /** Facts the Host publishes beside the commands. */
  readonly state: PaneState
  /** Connection state, so transient loss and a final refusal read differently. */
  readonly status: PaneStatus
  /** Set once the linkage fails terminally, whether binding or streaming. */
  readonly error?: string
}

/** React-free subscription surface, so views never own a transport. */
export interface PaneStreamStore {
  getSnapshot(): PaneStreamState
  subscribe(listener: () => void): () => void
}

/** A store plus the lifecycle its owner drives. */
export interface PaneStreamHandle extends PaneStreamStore {
  /** Begin consuming; repeated calls are inert. */
  start(): void
  /** Stop permanently and wait for the consumer to become quiescent. */
  dispose(): Promise<void>
}

export const nothingBound: PaneStreamState = { commands: [], state: {}, status: 'idle' }
const streamName = 'ORYH pane stream'

/** Text to publish for a terminal stream failure. */
function failureMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Chat 指令同步已中断。'
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
 * @returns an unstarted store owned by the caller.
 */
export function createPaneStream(remote: ClientRemote, request: PaneBindRequest): PaneStreamHandle {
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
      publish({ commands: [], state: {}, status: 'rejected', error: failureMessage(error) })
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
