import type {
  BeginConnectionView,
  ConnectionId,
  ConnectionSummary,
  DeviceAuthorizationId,
  OperationDefinition,
  OperationId,
  OperationResultId,
  OryhClientRemote,
  OryhOperationResult,
  PollConnectionView,
  SavedOperationId,
  SavedOperationView,
} from '@oryh/ai-client-core'

/** State displayed by the ORYH workspace shell or any platform-specific UI. */
export interface OryhWorkspaceSnapshot {
  readonly connections: readonly ConnectionSummary[]
  /** Undefined when the user must explicitly choose among several enterprises. */
  readonly activeConnectionId: ConnectionId | undefined
  readonly operations: readonly OperationDefinition[]
  readonly savedOperations: readonly SavedOperationView[]
  /** The current device flow, which contains no access or refresh credential. */
  readonly pendingConnection: BeginConnectionView | undefined
  /** Last result available for immediate reuse, saving, or explicit AI handoff. */
  readonly currentResult: OryhOperationResult | undefined
}

/** Browser-safe controller for direct ORYH actions. It never invokes a language model. */
export class OryhWorkspace {
  #connections: readonly ConnectionSummary[] = []
  #operations: readonly OperationDefinition[] = []
  #savedOperations: readonly SavedOperationView[] = []
  #activeConnectionId: ConnectionId | undefined
  #pendingConnection: BeginConnectionView | undefined
  #currentResult: OryhOperationResult | undefined
  #generation = 0

  constructor(private readonly remote: OryhClientRemote) {}

  /** Refresh connection-independent data and selected connection-specific direct actions. */
  async load(): Promise<OryhWorkspaceSnapshot> {
    const previousConnection = this.#activeConnectionId
    const generation = this.resetSelection()
    const [connections, operations] = await Promise.all([
      this.remote.listConnections(),
      this.remote.listOperations(),
    ])
    this.assertGeneration(generation)
    this.#connections = [...connections]
    this.#operations = [...operations]
    const selected = resolveActiveConnection(previousConnection, this.#connections)
    if (selected !== undefined) await this.activateConnection(selected, generation)
    return this.snapshot()
  }

  /** Publish a selected enterprise only after its identity and saved views have loaded. */
  async selectConnection(connectionId: ConnectionId): Promise<OryhWorkspaceSnapshot> {
    if (!this.#connections.some(connection => connection.id === connectionId)) {
      throw new OryhWorkspaceError('The selected ORYH connection is unavailable.', 'connection-not-found')
    }
    const generation = this.resetSelection()
    await this.activateConnection(connectionId, generation)
    return this.snapshot()
  }

  /** Start browser device authorization. Private authorization state remains in the Host. */
  async beginConnection(origin: string, clientName: string): Promise<OryhWorkspaceSnapshot> {
    this.#pendingConnection = await this.remote.beginConnection(origin, clientName)
    return this.snapshot()
  }

  /** Poll the current device authorization once and activate its connection on approval. */
  async pollConnection(): Promise<PollConnectionView> {
    const pending = this.requirePendingConnection()
    const generation = this.#generation
    const outcome = await this.remote.pollConnection(pending.authorizationId)
    this.assertGeneration(generation)
    if (this.#pendingConnection !== pending) throw staleRequest()
    if (outcome.state === 'connected') {
      this.#pendingConnection = undefined
      const nextGeneration = this.resetSelection()
      const connections = await this.remote.listConnections()
      const savedOperations = await this.remote.listSavedOperations(outcome.connection.id)
      this.assertGeneration(nextGeneration)
      this.#connections = [...connections]
      this.#savedOperations = [...savedOperations]
      this.#activeConnectionId = outcome.connection.id
    } else if (outcome.state === 'denied' || outcome.state === 'expired') {
      this.#pendingConnection = undefined
    }
    return outcome
  }

  /** Cancel the visible device authorization and discard its Host-side poll state. */
  async cancelConnection(): Promise<OryhWorkspaceSnapshot> {
    const pending = this.requirePendingConnection()
    this.#pendingConnection = undefined
    await this.remote.cancelConnection(pending.authorizationId)
    return this.snapshot()
  }

  /** Run one registered direct operation. This is a fixed ORYH API program, not an AI request. */
  async run(operationId: OperationId): Promise<OryhOperationResult> {
    const connectionId = this.requireActiveConnection()
    const generation = this.#generation
    const result = await this.remote.execute(connectionId, operationId)
    this.assertGeneration(generation)
    this.assertResultConnection(result, connectionId)
    this.#currentResult = result
    return result
  }

  /** Display one already-fetched result without sending another ORYH request or model request. */
  async reuse(operationId: OperationId, resultId: OperationResultId): Promise<OryhOperationResult> {
    const connectionId = this.requireActiveConnection()
    const generation = this.#generation
    const result = await this.remote.reuse(connectionId, operationId, resultId)
    this.assertGeneration(generation)
    this.assertResultConnection(result, connectionId)
    this.#currentResult = result
    return result
  }

  /** Save the current verified result's fixed operation as an immediately reusable business action. */
  async saveCurrentResult(label: string): Promise<SavedOperationView> {
    const connectionId = this.requireActiveConnection()
    const generation = this.#generation
    const result = this.#currentResult
    if (result === undefined || result.connectionId !== connectionId) {
      throw new OryhWorkspaceError('Run or reuse an ORYH result before saving it.', 'result-not-available')
    }
    const saved = await this.remote.saveResult(connectionId, result.operationId, result.id, label)
    this.assertGeneration(generation)
    const savedOperations = await this.remote.listSavedOperations(connectionId)
    this.assertGeneration(generation)
    this.#savedOperations = [...savedOperations]
    return saved
  }

  /** Refresh one user-saved direct operation without regenerating request code or calling a model. */
  async refreshSavedOperation(savedOperationId: SavedOperationId): Promise<OryhOperationResult> {
    const connectionId = this.requireActiveConnection()
    const generation = this.#generation
    const result = await this.remote.refreshSavedOperation(connectionId, savedOperationId)
    this.assertGeneration(generation)
    this.assertResultConnection(result, connectionId)
    this.#currentResult = result
    return result
  }

  /** Disconnect the selected tenant and clear all selected-tenant views from this workspace. */
  async disconnect(): Promise<OryhWorkspaceSnapshot> {
    const connectionId = this.requireActiveConnection()
    const generation = this.resetSelection()
    await this.remote.disconnect(connectionId)
    this.assertGeneration(generation)
    this.#connections = this.#connections.filter(connection => connection.id !== connectionId)
    const selected = resolveActiveConnection(undefined, this.#connections)
    if (selected !== undefined) await this.activateConnection(selected, generation)
    return this.snapshot()
  }

  /** Return a detached workspace snapshot suitable for rendering. */
  snapshot(): OryhWorkspaceSnapshot {
    return {
      connections: [...this.#connections],
      activeConnectionId: this.#activeConnectionId,
      operations: [...this.#operations],
      savedOperations: [...this.#savedOperations],
      pendingConnection: this.#pendingConnection,
      currentResult: this.#currentResult,
    }
  }

  private resetSelection(): number {
    this.#generation += 1
    this.#activeConnectionId = undefined
    this.#currentResult = undefined
    this.#savedOperations = []
    return this.#generation
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.#generation) throw staleRequest()
  }

  private async activateConnection(connectionId: ConnectionId, generation: number): Promise<void> {
    const verified = await this.remote.verifyConnection(connectionId)
    this.assertGeneration(generation)
    if (verified.id !== connectionId) throw new OryhWorkspaceError('The verified connection does not match the selected enterprise.', 'cross-connection-result')
    const savedOperations = await this.remote.listSavedOperations(connectionId)
    this.assertGeneration(generation)
    this.replaceConnection(verified)
    this.#savedOperations = [...savedOperations]
    this.#activeConnectionId = connectionId
  }

  private requireActiveConnection(): ConnectionId {
    if (this.#activeConnectionId === undefined) {
      throw new OryhWorkspaceError('Choose an ORYH enterprise connection first.', 'connection-required')
    }
    return this.#activeConnectionId
  }

  private requirePendingConnection(): BeginConnectionView {
    if (this.#pendingConnection === undefined) {
      throw new OryhWorkspaceError('There is no pending ORYH device authorization.', 'authorization-not-found')
    }
    return this.#pendingConnection
  }

  private assertResultConnection(result: OryhOperationResult, connectionId: ConnectionId): void {
    if (result.connectionId !== connectionId) {
      throw new OryhWorkspaceError('ORYH returned a result for a different connection.', 'cross-connection-result')
    }
  }

  /** Replace only the selected connection's mutable identity projection after Host verification. */
  private replaceConnection(verified: ConnectionSummary): void {
    this.#connections = this.#connections.map(connection => connection.id === verified.id ? verified : connection)
  }
}

/** UI-domain error emitted before any remote operation can target an ambiguous tenant. */
export class OryhWorkspaceError extends Error {
  constructor(message: string, readonly code: OryhWorkspaceErrorCode) {
    super(message)
    this.name = 'OryhWorkspaceError'
  }
}

/** Stable workspace error categories suitable for localized UI messages. */
export type OryhWorkspaceErrorCode =
  | 'stale-request'
  | 'authorization-not-found'
  | 'connection-not-found'
  | 'connection-required'
  | 'cross-connection-result'
  | 'result-not-available'

function resolveActiveConnection(
  current: ConnectionId | undefined,
  connections: readonly ConnectionSummary[],
): ConnectionId | undefined {
  if (current !== undefined && connections.some(connection => connection.id === current)) return current
  return connections.length === 1 ? connections[0]?.id : undefined
}

/** Keep opaque IDs in the public type import set even though UI code never constructs them. */
export type { DeviceAuthorizationId }

function staleRequest(): OryhWorkspaceError {
  return new OryhWorkspaceError('The workspace changed while this request was running.', 'stale-request')
}
