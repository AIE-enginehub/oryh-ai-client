import {
  deviceAuthorizationId,
  type ConnectionId,
  type DeviceAuthorizationId,
  type OperationResultId,
  type SavedOperationId,
} from './brand.js'
import type { ConnectionSummary } from './connections.js'
import type { OryhExpenseClaim, OryhProject, OryhTodo } from './contracts.js'
import type { DeviceAuthorizationPrompt, DeviceConnectionAttempt, DevicePollOutcome } from './device-flow.js'
import { OryhClientError } from './errors.js'
import { OryhClientHost } from './host.js'
import { OPERATIONS, type OperationDefinition, type OperationId, type OperationResult } from './operations.js'
import { SavedOperationRegistry, type SavedOperationStore, type SavedOperationView } from './saved-operations.js'

/** Host-owned optional dependencies for browser-safe ORYH controller state. */
export interface OryhClientControllerOptions {
  /** Persistent non-secret storage for saved direct-operation records. */
  readonly savedOperationStore?: SavedOperationStore
}

/** Browser-safe result of beginning an ORYH device connection. */
export interface BeginConnectionView {
  readonly authorizationId: DeviceAuthorizationId
  readonly prompt: DeviceAuthorizationPrompt
}

/** Browser-safe outcome of polling one ORYH device authorization. */
export type PollConnectionView =
  | { readonly state: 'pending'; readonly pollIntervalSeconds: number }
  | { readonly state: 'denied' | 'expired' }
  | { readonly state: 'connected'; readonly connection: ConnectionSummary }

/**
 * Typed BFF controller used by a future DSH Typert Remote service.
 * Device authorization state belongs to this Host object; no caller receives a
 * device code, credential pair, transport, or mutable connection registry.
 */
export class OryhClientController {
  readonly #attempts = new Map<DeviceAuthorizationId, DeviceConnectionAttempt>()
  readonly #savedOperations = new SavedOperationRegistry()
  readonly #savedOperationStore: SavedOperationStore | undefined
  readonly #ready: Promise<void>
  #nextAuthorizationId = 1

  constructor(private readonly host: OryhClientHost, options: OryhClientControllerOptions = {}) {
    this.#savedOperationStore = options.savedOperationStore
    this.#ready = this.restoreSavedOperations()
  }

  /** Start a browser device authorization and retain its private poll state locally. */
  async beginConnection(origin: string, clientName: string): Promise<BeginConnectionView> {
    await this.#ready
    const attempt = await this.host.beginDeviceConnection(origin, clientName)
    const authorizationId = deviceAuthorizationId(`authorization-${this.#nextAuthorizationId}`)
    this.#nextAuthorizationId += 1
    this.#attempts.set(authorizationId, attempt)
    return { authorizationId, prompt: attempt.prompt }
  }

  /** Poll a retained authorization once; terminal attempts are immediately forgotten. */
  async pollConnection(authorizationId: DeviceAuthorizationId): Promise<PollConnectionView> {
    await this.#ready
    const attempt = this.#attempts.get(authorizationId)
    if (attempt === undefined) {
      throw new OryhClientError('The ORYH device authorization no longer exists.', 'connection-not-found')
    }
    const outcome = await attempt.pollOnce()
    if (outcome.state !== 'pending') this.#attempts.delete(authorizationId)
    return pollView(outcome)
  }

  /** Forget an unfinished authorization when its browser flow is dismissed. */
  cancelConnection(authorizationId: DeviceAuthorizationId): void {
    if (!this.#attempts.delete(authorizationId)) {
      throw new OryhClientError('The ORYH device authorization no longer exists.', 'connection-not-found')
    }
  }

  /** List local, non-secret connection summaries. */
  listConnections(): Promise<readonly ConnectionSummary[]> {
    return this.host.connections()
  }

  /** Verify one restored connection before its browser workbench runs an operation. */
  verifyConnection(connectionId: ConnectionId): Promise<ConnectionSummary> {
    return this.host.verifyConnection(connectionId)
  }

  /** List the allowlisted deterministic business operations available to the UI. */
  listOperations(): readonly OperationDefinition[] {
    return OPERATIONS
  }

  /** Execute one registered read operation under exactly one existing connection. */
  execute(
    connectionId: ConnectionId,
    operationId: 'my-open-todos',
  ): Promise<OperationResult<OryhTodo>>
  execute(
    connectionId: ConnectionId,
    operationId: 'list-projects',
  ): Promise<OperationResult<OryhProject>>
  execute(
    connectionId: ConnectionId,
    operationId: 'my-expense-claims',
  ): Promise<OperationResult<OryhExpenseClaim>>
  execute(
    connectionId: ConnectionId,
    operationId: OperationId,
  ): Promise<OperationResult<OryhTodo> | OperationResult<OryhExpenseClaim> | OperationResult<OryhProject>> {
    switch (operationId) {
      case 'my-open-todos':
        return this.host.executeMyOpenTodos(connectionId)
      case 'my-expense-claims':
        return this.host.executeMyExpenseClaims(connectionId)
      case 'list-projects':
        return this.host.executeProjects(connectionId)
      default:
        return assertNever(operationId)
    }
  }

  /** Reuse a prior operation result without sending another ORYH request. */
  reuse(
    connectionId: ConnectionId,
    operationId: 'my-open-todos',
    resultId: OperationResultId,
  ): Promise<OperationResult<OryhTodo>>
  reuse(
    connectionId: ConnectionId,
    operationId: 'list-projects',
    resultId: OperationResultId,
  ): Promise<OperationResult<OryhProject>>
  reuse(
    connectionId: ConnectionId,
    operationId: 'my-expense-claims',
    resultId: OperationResultId,
  ): Promise<OperationResult<OryhExpenseClaim>>
  reuse(
    connectionId: ConnectionId,
    operationId: OperationId,
    resultId: OperationResultId,
  ): Promise<OperationResult<OryhTodo> | OperationResult<OryhExpenseClaim> | OperationResult<OryhProject>> {
    switch (operationId) {
      case 'my-open-todos':
        return this.host.reuseTodoResult(connectionId, resultId)
      case 'my-expense-claims':
        return this.host.reuseExpenseClaimResult(connectionId, resultId)
      case 'list-projects':
        return this.host.reuseProjectResult(connectionId, resultId)
      default:
        return assertNever(operationId)
    }
  }

  /** Pin one already-executed operation for direct, model-free refresh later. */
  async saveResult(
    connectionId: ConnectionId,
    operationId: OperationId,
    resultId: OperationResultId,
    label: string,
    createdAt = new Date().toISOString(),
  ): Promise<SavedOperationView> {
    await this.#ready
    // `reuse` verifies the result exists and belongs to this exact connection;
    // its payload is intentionally discarded because a saved view stores only
    // the registered operation identity, not a stale snapshot or request code.
    switch (operationId) {
      case 'my-open-todos':
        await this.host.reuseTodoResult(connectionId, resultId)
        break
      case 'my-expense-claims':
        await this.host.reuseExpenseClaimResult(connectionId, resultId)
        break
      case 'list-projects':
        await this.host.reuseProjectResult(connectionId, resultId)
        break
      default:
        return assertNever(operationId)
    }
    const saved = this.#savedOperations.save({ connectionId, operationId, resultId, label }, createdAt)
    await this.persistSavedOperations()
    return saved
  }

  /** List the current connection's saved model-free actions. */
  async listSavedOperations(connectionId: ConnectionId): Promise<readonly SavedOperationView[]> {
    await this.#ready
    await this.host.connection(connectionId)
    return this.#savedOperations.list(connectionId)
  }

  /** Run one saved operation exactly as its registered program defines it. */
  async refreshSavedOperation(
    connectionId: ConnectionId,
    savedOperationId: SavedOperationId,
  ): Promise<OperationResult<OryhTodo> | OperationResult<OryhExpenseClaim> | OperationResult<OryhProject>> {
    await this.#ready
    const saved = this.#savedOperations.require(connectionId, savedOperationId)
    switch (saved.operationId) {
      case 'my-open-todos':
        return this.host.executeMyOpenTodos(connectionId)
      case 'my-expense-claims':
        return this.host.executeMyExpenseClaims(connectionId)
      case 'list-projects':
        return this.host.executeProjects(connectionId)
      default:
        return assertNever(saved.operationId)
    }
  }

  /** Remove one local connection and its Host-side credential bundle. */
  async disconnect(connectionId: ConnectionId): Promise<void> {
    await this.#ready
    await this.host.disconnect(connectionId)
    this.#savedOperations.removeConnection(connectionId)
    await this.persistSavedOperations()
  }

  private async restoreSavedOperations(): Promise<void> {
    if (this.#savedOperationStore === undefined) return
    this.#savedOperations.restore(await this.#savedOperationStore.load())
  }

  private async persistSavedOperations(): Promise<void> {
    if (this.#savedOperationStore === undefined) return
    await this.#savedOperationStore.save(this.#savedOperations.listAll())
  }
}

function pollView(outcome: DevicePollOutcome): PollConnectionView {
  switch (outcome.state) {
    case 'pending':
      return outcome
    case 'denied':
    case 'expired':
      return outcome
    case 'connected':
      return outcome
    default:
      return assertNever(outcome)
  }
}

function assertNever(value: never): never {
  throw new OryhClientError(`Unsupported ORYH controller value: ${String(value)}`, 'operation-not-found')
}
