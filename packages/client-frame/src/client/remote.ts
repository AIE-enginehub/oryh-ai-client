/** The frame's Remote, built over Harness's generated one. What a page may ask of it is the kit's `FrameRemote`. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { connectionRequest, type FrameRemote, unwrap } from '@oryh/ai-client-kit'
import type {} from '@oryh/dsh-connection/remote'
import type {} from '@oryh/dsh-pane/remote'
import { createPaneStream } from './pane-stream.js'

/** The only browser transport is the generated, authenticated Harness Remote. */
export function createFrameRemote(remote: ClientRemote, streamBroken: () => string): FrameRemote {
  const connections = remote.oryh
  const pane = remote.oryhPane
  return {
    activateProfile: connectionId => unwrap(connections.activateProfile({ connectionId })),
    connectionDefaults: () => unwrap(connections.connectionDefaults()),
    listConnections: () => unwrap(connections.listConnections()),
    listOperations: () => unwrap(connections.listOperations()),
    beginConnection: (origin, clientName) => unwrap(connections.beginConnection({ origin, clientName })),
    pollConnection: authorizationId => unwrap(connections.pollConnection({ authorizationId })),
    cancelConnection: authorizationId => unwrap(connections.cancelConnection({ authorizationId })),
    verifyConnection: connectionId => unwrap(connections.verifyConnection({ connectionId })),
    disconnect: connectionId => unwrap(connections.disconnect({ connectionId })),
    execute: (connectionId, operationId) => unwrap(connections.execute({ connectionId, operationId })),
    executeOne: (connectionId, operationId, id) => unwrap(connections.executeOne({ connectionId, operationId, id })),
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
    openPane: request => createPaneStream(remote, request, streamBroken),
    paneMenu: connectionId => unwrap(pane.paneMenu({ connectionId })),
    paneOpenRecord: request => unwrap(pane.paneOpenRecord(request)),
    paneAsk: request => unwrap(pane.paneAsk(request)),
    paneShareView: request => unwrap(pane.paneShareView(request)),
    paneCopySharedView: request => unwrap(pane.paneCopySharedView(request)),
    reviewClear: (sessionId, connectionId) => unwrap(pane.reviewClear({ sessionId, connectionId })),
  }
}
