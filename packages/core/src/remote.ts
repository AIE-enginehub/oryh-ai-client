import type { ConnectionId, DeviceAuthorizationId, OperationResultId, SavedOperationId } from './brand.js'
import type { ConnectionSummary } from './connections.js'
import type { OryhExpenseClaim, OryhProject, OryhTodo } from './contracts.js'
import type { BeginConnectionView, OryhClientController, PollConnectionView } from './controller.js'
import type { OperationDefinition, OperationId, OperationResult } from './operations.js'
import type { SavedOperationView } from './saved-operations.js'

/** One browser-safe result returned by a registered deterministic operation. */
export type OryhOperationResult =
  | OperationResult<OryhTodo>
  | OperationResult<OryhExpenseClaim>
  | OperationResult<OryhProject>

/**
 * Browser-facing ORYH BFF methods. A generated DSH Typert Remote will expose
 * this exact API; it intentionally contains only opaque identifiers and
 * browser-safe business facts.
 */
export interface OryhClientRemote {
  /** Begin device authorization without returning the private device code. */
  beginConnection(origin: string, clientName: string): Promise<BeginConnectionView>
  /** Poll a pending device authorization retained by the Host. */
  pollConnection(authorizationId: DeviceAuthorizationId): Promise<PollConnectionView>
  /** Forget a pending device authorization and its private poll state. */
  cancelConnection(authorizationId: DeviceAuthorizationId): Promise<void>
  /** List local ORYH connection summaries. */
  listConnections(): Promise<readonly ConnectionSummary[]>
  /** Verify one selected connection against `/auth/me` before exposing business operations. */
  verifyConnection(connectionId: ConnectionId): Promise<ConnectionSummary>
  /** List registered direct-operation buttons. */
  listOperations(): Promise<readonly OperationDefinition[]>
  /** Run one fixed ORYH read operation under the selected connection. */
  execute(connectionId: ConnectionId, operationId: OperationId): Promise<OryhOperationResult>
  /** Reuse one cached result without calling ORYH or a model. */
  reuse(connectionId: ConnectionId, operationId: OperationId, resultId: OperationResultId): Promise<OryhOperationResult>
  /** Pin one verified operation as a direct, model-free action. */
  saveResult(
    connectionId: ConnectionId,
    operationId: OperationId,
    resultId: OperationResultId,
    label: string,
  ): Promise<SavedOperationView>
  /** List direct actions saved under the selected connection only. */
  listSavedOperations(connectionId: ConnectionId): Promise<readonly SavedOperationView[]>
  /** Refresh one saved direct operation without using a model. */
  refreshSavedOperation(connectionId: ConnectionId, savedOperationId: SavedOperationId): Promise<OryhOperationResult>
  /** Remove a connection and its Host-owned credential bundle. */
  disconnect(connectionId: ConnectionId): Promise<void>
}

/**
 * Promise-based transport adapter for the in-process Host controller.
 * The adapter gives local tests and future Typert transport the same public
 * browser API, while controller internals and credentials remain Host-only.
 */
export class OryhClientRemoteAdapter implements OryhClientRemote {
  constructor(private readonly controller: OryhClientController) {}

  beginConnection(origin: string, clientName: string): Promise<BeginConnectionView> {
    return this.controller.beginConnection(origin, clientName)
  }

  pollConnection(authorizationId: DeviceAuthorizationId): Promise<PollConnectionView> {
    return this.controller.pollConnection(authorizationId)
  }

  async cancelConnection(authorizationId: DeviceAuthorizationId): Promise<void> {
    this.controller.cancelConnection(authorizationId)
  }

  async listConnections(): Promise<readonly ConnectionSummary[]> {
    return this.controller.listConnections()
  }

  verifyConnection(connectionId: ConnectionId): Promise<ConnectionSummary> {
    return this.controller.verifyConnection(connectionId)
  }

  async listOperations(): Promise<readonly OperationDefinition[]> {
    return this.controller.listOperations()
  }

  execute(connectionId: ConnectionId, operationId: OperationId): Promise<OryhOperationResult> {
    switch (operationId) {
      case 'my-open-todos':
        return this.controller.execute(connectionId, operationId)
      case 'my-expense-claims':
        return this.controller.execute(connectionId, operationId)
      case 'list-projects':
        return this.controller.execute(connectionId, operationId)
      default:
        return assertNever(operationId)
    }
  }

  async reuse(
    connectionId: ConnectionId,
    operationId: OperationId,
    resultId: OperationResultId,
  ): Promise<OryhOperationResult> {
    switch (operationId) {
      case 'my-open-todos':
        return this.controller.reuse(connectionId, operationId, resultId)
      case 'my-expense-claims':
        return this.controller.reuse(connectionId, operationId, resultId)
      case 'list-projects':
        return this.controller.reuse(connectionId, operationId, resultId)
      default:
        return assertNever(operationId)
    }
  }

  async saveResult(
    connectionId: ConnectionId,
    operationId: OperationId,
    resultId: OperationResultId,
    label: string,
  ): Promise<SavedOperationView> {
    return this.controller.saveResult(connectionId, operationId, resultId, label)
  }

  async listSavedOperations(connectionId: ConnectionId): Promise<readonly SavedOperationView[]> {
    return this.controller.listSavedOperations(connectionId)
  }

  refreshSavedOperation(connectionId: ConnectionId, savedOperationId: SavedOperationId): Promise<OryhOperationResult> {
    return this.controller.refreshSavedOperation(connectionId, savedOperationId)
  }

  disconnect(connectionId: ConnectionId): Promise<void> {
    return this.controller.disconnect(connectionId)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported ORYH operation id: ${String(value)}`)
}
