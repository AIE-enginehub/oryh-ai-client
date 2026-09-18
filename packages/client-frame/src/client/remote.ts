import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { OryhClientRemote, SkillRefreshResult } from '@oryh/ai-client-core/types'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type {} from '@oryh/dsh-connection/remote'
import type {} from '@oryh/dsh-pane/remote'
import type { PaneBindRequest, PaneBindView, PaneSync } from '@oryh/dsh-pane/types'
import { createContext, useContext } from 'react'
import { createPaneStream, type PaneStreamHandle } from './pane-stream.js'

/** The pane's side of the bridge, and what every page needs of the connection. */
export interface PaneRemote {
  /** Bind the session to its enterprise; the pane speaks for it from then on. */
  paneBind(request: PaneBindRequest): Promise<PaneBindView>
  paneUnbind(sessionId: string): Promise<void>
  /** What the pane shows now, and the commands it carried out. */
  paneSync(request: PaneSync): Promise<void>
  /** Follow the agent's commands and the Host's published state for a bound session. */
  openPane(request: PaneBindRequest): PaneStreamHandle
  /** Drop the pre-submit review when the person skips it or the submission settles. */
  reviewClear(sessionId: string): Promise<void>
}
export interface ConnectionRemote {
  connectionDefaults(): Promise<{ origin: string; signOut?: string }>
  skillSync(connectionId: string, force?: boolean): Promise<SkillRefreshResult>
}
/**
 * The frame's Remote: connections and their operations (`oryh`), and the pane bridge (`oryhPane`).
 * Each page plugin mounts its own domain namespace beside these.
 */
export type FrameRemote = ConnectionRemote & PaneRemote & OryhClientRemote

export const RemoteContext = createContext<FrameRemote | undefined>(undefined)
export function useOryhRemote(): FrameRemote {
  const remote = useContext(RemoteContext)
  if (!remote) throw new Error('ORYH Remote is not mounted')
  return remote
}
export class LocalRemoteError extends Error {
  /**
   * @param code - the ORYH business code when `business`, otherwise the Gateway's own code.
   * @param message - failure text safe to show.
   * @param business - whether the Host refused on purpose, as opposed to a transport or protocol
   * failure. A refusal will not change by asking again, so callers must not retry it.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly business = false,
  ) {
    super(message)
    this.name = 'OryhRemoteError'
  }
}
/**
 * Settle a generated Remote call: the value, or a `LocalRemoteError` carrying the Host's business
 * code when it refused on purpose. Every page plugin's facade goes through this.
 */
export async function unwrap<T>(
  call: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: object } }>,
): Promise<T> {
  const result = await call
  if (!result.ok) {
    const details = result.error.details
    const business = result.error.code === 'oryh/business'
    const code =
      business && details && 'code' in details && typeof details.code === 'string' ? details.code : result.error.code
    throw new LocalRemoteError(code, result.error.message, business)
  }
  return result.value
}
/** The request shape every domain namespace takes: the enterprise connection it is about. */
export const connectionRequest = (connectionId: string): { connectionId: ConnectionId } => ({
  connectionId: connectionId as ConnectionId,
})
/** The only browser transport is the generated, authenticated Harness Remote. */
export function createFrameRemote(remote: ClientRemote): FrameRemote {
  const connections = remote.oryh
  const pane = remote.oryhPane
  return {
    connectionDefaults: () => unwrap(connections.connectionDefaults()),
    listConnections: () => unwrap(connections.listConnections()),
    listOperations: () => unwrap(connections.listOperations()),
    beginConnection: (origin, clientName) => unwrap(connections.beginConnection({ origin, clientName })),
    pollConnection: authorizationId => unwrap(connections.pollConnection({ authorizationId })),
    cancelConnection: authorizationId => unwrap(connections.cancelConnection({ authorizationId })),
    verifyConnection: connectionId => unwrap(connections.verifyConnection({ connectionId })),
    disconnect: connectionId => unwrap(connections.disconnect({ connectionId })),
    execute: (connectionId, operationId) => unwrap(connections.execute({ connectionId, operationId })),
    reuse: (connectionId, operationId, resultId) => unwrap(connections.reuse({ connectionId, operationId, resultId })),
    saveResult: (connectionId, operationId, resultId, label) =>
      unwrap(connections.saveResult({ connectionId, operationId, resultId, label })),
    listSavedOperations: connectionId => unwrap(connections.listSavedOperations({ connectionId })),
    refreshSavedOperation: (connectionId, savedOperationId) =>
      unwrap(connections.refreshSavedOperation({ connectionId, savedOperationId })),
    skillSync: (connectionId, force) =>
      unwrap(connections.skillSync({ ...connectionRequest(connectionId), ...(force ? { force } : {}) })),
    paneBind: request => unwrap(pane.paneBind(request)),
    paneUnbind: sessionId => unwrap(pane.paneUnbind({ sessionId })),
    paneSync: request => unwrap(pane.paneSync(request)),
    openPane: request => createPaneStream(remote, request),
    reviewClear: sessionId => unwrap(pane.reviewClear({ sessionId })),
  }
}
