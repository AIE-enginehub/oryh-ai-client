import { AttachmentUploader } from './attachments.js'
import type { ConnectionId, OperationResultId } from './brand.js'
import type { ConnectionStore } from './connection-store.js'
import { ConnectionRegistry, type ConnectionSummary } from './connections.js'
import { decodeIdentity, type OryhTodo } from './contracts.js'
import type { CredentialHandoff, HandedOffCredential } from './credential-handoff.js'
import type { CredentialVault } from './credentials.js'
import { type ConnectionAdmission, type DeviceConnectionAttempt, DeviceFlowConnector } from './device-flow.js'
import { OryhClientError } from './errors.js'
import type { Fetcher } from './http.js'
import { OryhHttpClient } from './http.js'
import { ListParameters } from './list-parameters.js'
import { OryhMcpClient } from './mcp.js'
import { OperationExecutor, type OperationId, type OperationResult, type OperationValue } from './operations.js'
import { PageReader } from './page-reads.js'
import type { ServerBinding } from './server-binding.js'
import { SkillBundleService } from './skill-bundle.js'
import { WorkflowDefinitions } from './workflow.js'

/** Dependencies owned by a native shell or DSH Host integration. */
export interface OryhClientHostOptions {
  /** Host-only secret store supplied by the product's credential service. */
  readonly credentialVault: CredentialVault
  /** Host network transport; production normally passes `globalThis.fetch`. */
  readonly fetcher: Fetcher
  /** Injectable clock for deterministic receipts and tests. */
  readonly clock?: () => Date
  /** Non-secret connection metadata store; production persists it outside the credential vault. */
  readonly connectionStore?: ConnectionStore
  /** Trusted server-only binding. Bound by createServerOryhHost, never browser configuration. */
  readonly serverBinding?: ServerBinding
  /** Credentials a trusted sign-in in the same deployment leaves for this Host to adopt. */
  readonly credentialHandoff?: CredentialHandoff
  /**
   * How long a verification stays good. Within it `verifyConnection` answers from the last `/auth/me`
   * instead of asking again; 0 (the default) asks every time. A Host that serves an agent sets it,
   * and forgets every verification when a turn starts, so one turn costs one `/auth/me`.
   */
  readonly verifyTtlMs?: number
  /** Who may connect an enterprise here, where the deployment belongs to one person; throws to refuse. */
  readonly connectionAdmission?: ConnectionAdmission
}

/**
 * What a domain builds its own service on: reads of ORYH as a connection this Host holds, and the ways
 * to ask who that connection is. No domain is known here — a plugin takes this, builds its service and
 * provides it (ADR-0014). It can only read: `http` passes on a path and nothing else, so the transport
 * with its writes, and the credentials behind it, stay where they are.
 */
export interface OryhDomainReads {
  /** GET one path under `/api/v1` as a connection. */
  readonly http: {
    request(connectionId: ConnectionId, request: { readonly path: `/${string}` }): Promise<unknown>
  }
  /** Ask ORYH who this connection is; answered from the last asking while that is still good. */
  verify(connectionId: string): Promise<ConnectionSummary>
  /** A connection already verified. Throws when it is not. */
  current(connectionId: string): ConnectionSummary
  /** The same, once the Host is ready and a verification under way has settled. */
  settled(connectionId: string): Promise<ConnectionSummary>
  /** What ORYH's own schema says each list can be filtered by and what its rows carry; a lookup of its own per call. */
  lists(): ListParameters
}

/**
 * Product Host facade: connection lifecycle and registered business operations.
 * It never exposes credentials, HTTP transport, or the mutable connection registry.
 */
export class OryhClientHost {
  readonly #connections = new ConnectionRegistry()
  readonly #http: OryhHttpClient
  readonly #devices: DeviceFlowConnector
  readonly #operations: OperationExecutor
  readonly #credentials: CredentialVault
  readonly #connectionStore: ConnectionStore | undefined
  #ready: Promise<void> | undefined
  private readonly serverBinding: ServerBinding | undefined
  private detachServer: () => void = () => {}
  readonly #verifications = new Map<ConnectionId, Promise<ConnectionSummary>>()
  readonly #verifiedAt = new Map<ConnectionId, number>()
  readonly #verifyTtlMs: number
  readonly #handoff: CredentialHandoff | undefined
  #adopting: Promise<void> = Promise.resolve()

  constructor(options: OryhClientHostOptions) {
    if (options.serverBinding && options.connectionStore)
      throw new Error('Server binding cannot restore desktop connections')
    this.serverBinding = options.serverBinding
    this.#verifyTtlMs = options.verifyTtlMs ?? 0
    this.#credentials = options.credentialVault
    this.#connectionStore = options.connectionStore
    this.#handoff = options.serverBinding ? undefined : options.credentialHandoff
    this.#http = new OryhHttpClient(
      this.#connections,
      this.#credentials,
      options.fetcher,
      options.serverBinding ? { delegated: options.serverBinding } : {},
    )
    this.#devices = new DeviceFlowConnector(
      this.#connections,
      this.#credentials,
      options.fetcher,
      async () => this.persistConnections(),
      options.connectionAdmission,
    )
    this.#operations = new OperationExecutor(this.#connections, this.#http, options.clock)
    this.ready()
    if (this.serverBinding) {
      const revoke = () => {
        for (const connection of this.#connections.list()) {
          this.#connections.revokeVerification(connection.id)
          this.#operations.clearConnection(connection.id)
          void this.#http.close(connection.id)
        }
      }
      this.serverBinding.signal.addEventListener('abort', revoke, { once: true })
      this.detachServer = () => this.serverBinding?.signal.removeEventListener('abort', revoke)
      if (this.serverBinding.signal.aborted) revoke()
    }
  }

  /** What a domain's plugin builds its own service on: reads only, as a connection held here. */
  createDomainReads(): OryhDomainReads {
    return {
      http: { request: (connectionId, request) => this.#http.request(connectionId, { path: request.path }) },
      verify: id => this.verifyConnection(id as ConnectionId),
      current: id => this.#connections.requireVerified(id as ConnectionId),
      settled: async id => {
        await this.ready()
        await this.#verifications.get(id as ConnectionId)
        return this.#connections.requireVerified(id as ConnectionId)
      },
      lists: () => new ListParameters(this.#http),
    }
  }
  /** Which object types this tenant governs with a workflow definition; shared by every domain. */
  createWorkflowDefinitions() {
    return new WorkflowDefinitions(this.#http)
  }
  /** Reads ORYH for a custom page's data run: GET only, as the person the page belongs to. */
  createPageReader() {
    return new PageReader(this.#http, id => this.verifyConnection(id))
  }
  /** Stores a file the person chose — on a page or attached in Chat — as an ORYH attachment. */
  createAttachmentUploader() {
    return new AttachmentUploader(this.#http, id => this.verifyConnection(id))
  }
  /** ORYH's MCP endpoint, for the tools the agent calls; the credential stays inside the shared HTTP client. */
  createMcpClient() {
    return new OryhMcpClient(this.#http)
  }
  /** ORYH skill installer, reading skills from MCP; the credential stays inside the shared HTTP client. */
  createSkillBundle(root: string) {
    if (this.serverBinding && this.serverBinding.installSkills !== true)
      throw new OryhClientError('Server skills are delivered through MCP.', 'request-failed')
    // The holder is read from the connection as already verified. Starting a verification here would
    // clear the connection's in-flight business reads, and a skill sync runs whenever the workbench opens.
    return new SkillBundleService(this.#http, root, async id => {
      await this.ready()
      await this.#verifications.get(id)
      const { origin, identity } = this.#connections.requireVerified(id)
      return {
        origin,
        tenantId: identity.tenant.id,
        userId: identity.user.id,
        employeeId: identity.user.employeeId,
        tenantName: identity.tenant.name ?? identity.tenant.slug,
        email: identity.user.email,
      }
    })
  }

  /** Start browser-backed device authorization for one ORYH deployment. */
  async beginDeviceConnection(origin: string, clientName: string): Promise<DeviceConnectionAttempt> {
    await this.ready()
    if (this.serverBinding)
      throw new OryhClientError('Server connections use the authenticated browser login.', 'request-failed')
    return this.#devices.begin(origin, clientName)
  }

  /** List non-secret connection summaries for a local UI or Remote response. */
  async connections(): Promise<readonly ConnectionSummary[]> {
    await this.ready()
    await this.adoptHandoff()
    return this.#connections.list()
  }

  /**
   * Turn a handed-off credential into a verified connection.
   *
   * Listing connections is what a workbench does first when it opens, which is right after the
   * gateway's sign-in redirected there. Signing in again as the same person in the same enterprise
   * replaces that connection's credential instead of adding a duplicate. A `sole` sign-in also forgets
   * every other connection: the container changed hands, and the last person's credential goes with them.
   */
  private adoptHandoff(): Promise<void> {
    if (this.#handoff === undefined) return Promise.resolve()
    const handoff = this.#handoff
    const run = this.#adopting.then(async () => {
      const taken = await handoff.take()
      if (taken !== undefined) await this.adopt(taken)
    })
    this.#adopting = run.catch(() => {})
    return run
  }

  private async adopt({ origin, credential, sole }: HandedOffCredential): Promise<void> {
    const temporary = this.#connections.add({ origin, identity: handoffIdentity })
    await this.#credentials.write(temporary.id, credential)
    let identity
    try {
      identity = decodeIdentity(await this.#http.request(temporary.id, { path: '/auth/me' }))
    } catch (error) {
      await this.#credentials.remove(temporary.id)
      this.#connections.remove(temporary.id)
      throw error
    }
    const existing = this.#connections
      .list()
      .find(
        connection =>
          connection.id !== temporary.id &&
          connection.origin === temporary.origin &&
          connection.identity.tenant.id === identity.tenant.id &&
          connection.identity.user.id === identity.user.id,
      )
    const kept = existing?.id ?? temporary.id
    if (existing === undefined) {
      this.#connections.markVerified(temporary.id, identity)
    } else {
      await this.#credentials.write(existing.id, credential)
      await this.#credentials.remove(temporary.id)
      this.#connections.remove(temporary.id)
      this.#connections.markVerified(existing.id, identity)
    }
    if (sole) {
      for (const other of this.#connections.list()) if (other.id !== kept) await this.forget(other.id)
    }
    await this.#credentials.bindConnection?.(this.#connections.require(kept))
    await this.persistConnections()
  }

  /**
   * Verify a restored connection against the current ORYH credential before
   * publishing it for business operations. The stable user and tenant IDs may
   * not change under one local connection; mutable identity facts may refresh.
   */
  async verifyConnection(connectionId: ConnectionId): Promise<ConnectionSummary> {
    await this.ready()
    const active = this.#verifications.get(connectionId)
    if (active !== undefined) return active
    const verifiedAt = this.#verifiedAt.get(connectionId)
    if (verifiedAt !== undefined && Date.now() - verifiedAt < this.#verifyTtlMs) {
      try {
        return this.#connections.requireVerified(connectionId)
      } catch {
        /* revoked since: ask again */
      }
    }
    const verification = this.verifyIdentity(connectionId)
    this.#verifications.set(connectionId, verification)
    try {
      const verified = await verification
      this.#verifiedAt.set(connectionId, Date.now())
      return verified
    } finally {
      this.#verifications.delete(connectionId)
    }
  }

  /** Make the next verification ask ORYH again, whatever the TTL: a new agent turn starts from the truth. */
  forgetVerifications(): void {
    this.#verifiedAt.clear()
  }

  private async verifyIdentity(connectionId: ConnectionId): Promise<ConnectionSummary> {
    const existing = this.#connections.require(connectionId)
    this.#verifiedAt.delete(connectionId)
    this.#connections.revokeVerification(connectionId)
    this.#operations.clearConnection(connectionId)
    const identity = decodeIdentity(await this.#http.request(connectionId, { path: '/auth/me' }))
    if (identity.user.id !== existing.identity.user.id || identity.tenant.id !== existing.identity.tenant.id) {
      throw new OryhClientError(
        'ORYH authentication no longer belongs to this local connection.',
        'connection-identity-mismatch',
      )
    }
    this.#http.assertOpen(connectionId)
    const verified = this.#connections.markVerified(connectionId, identity)
    await this.persistConnections()
    return verified
  }

  /**
   * Verify a connection that a failed verification left unverified. Verification is revoked before
   * `/auth/me` is asked again, so asking while ORYH was down left the lists refusing "not verified" after
   * it came back, until the page reloaded; a list asks once more instead.
   */
  private async verifiedAgain(connectionId: ConnectionId): Promise<void> {
    if (!this.#connections.isVerified(connectionId)) await this.verifyConnection(connectionId)
  }

  /** Execute the employee-bound "my open todos" operation. */
  async executeMyOpenTodos(connectionId: ConnectionId): Promise<OperationResult<OryhTodo>> {
    await this.ready()
    await this.verifiedAgain(connectionId)
    return this.#operations.execute(connectionId, 'my-open-todos')
  }

  /** Read one record of an operation's list by id, as a list of one (see {@link OperationExecutor.one}). */
  async executeOne(
    connectionId: ConnectionId,
    operationId: OperationId,
    id: string,
  ): Promise<OperationResult<OperationValue>> {
    await this.ready()
    await this.verifiedAgain(connectionId)
    return this.#operations.one(connectionId, operationId, id)
  }

  /** Reuse a prior todo result without making a new ORYH request. */
  async reuseTodoResult(connectionId: ConnectionId, resultId: OperationResultId): Promise<OperationResult<OryhTodo>> {
    await this.ready()
    return this.#operations.reuse(connectionId, resultId, 'my-open-todos')
  }

  /** Forget all local state and Host credentials for one disconnected enterprise. */
  async disconnect(connectionId: ConnectionId): Promise<void> {
    await this.ready()
    this.#connections.require(connectionId)
    await this.forget(connectionId)
    if (this.serverBinding) this.detachServer()
    await this.persistConnections()
  }

  private async forget(connectionId: ConnectionId): Promise<void> {
    this.#connections.revokeVerification(connectionId)
    this.#operations.clearConnection(connectionId)
    await this.#http.close(connectionId)
    await this.#credentials.remove(connectionId)
    this.#connections.remove(connectionId)
  }

  /** Confirm that a connection belongs to the restored and active Host registry. */
  async connection(connectionId: ConnectionId): Promise<ConnectionSummary> {
    await this.ready()
    return this.#connections.require(connectionId)
  }

  /** Share one initialization attempt; a failed attempt must not poison later user retries. */
  private ready(): Promise<void> {
    if (this.#ready) return this.#ready
    const attempt = this.restoreConnections()
    this.#ready = attempt
    // Initialization starts eagerly, before a caller may be waiting. Observe the rejection without
    // hiding it from that caller, then let the next request retry. Success remains cached.
    void attempt.catch(() => {
      if (this.#ready === attempt) this.#ready = undefined
    })
    return attempt
  }

  private async restoreConnections(): Promise<void> {
    if (this.serverBinding) {
      // A failed verification leaves the bound connection unverified. Retry that same connection:
      // callers may already know its ID, and a retry must not accumulate duplicate connections.
      const connection =
        this.#connections.list()[0] ??
        this.#connections.add({
          origin: this.serverBinding.origin,
          identity: this.serverBinding.identity,
        })
      await this.verifyIdentity(connection.id)
      return
    }
    if (this.#connectionStore === undefined) return
    const stored = await this.#connectionStore.load()
    const restorable: ConnectionSummary[] = []
    for (const connection of stored) {
      try {
        await this.#credentials.bindConnection?.(connection)
        if ((await this.#credentials.read(connection.id)) !== undefined) restorable.push(connection)
      } catch (error) {
        // A refused legacy-keychain migration must not erase saved identities or
        // prevent starting a new sign-in. Verification still refuses every
        // business operation until a credential can actually be read and checked.
        if (!(error instanceof OryhClientError) || error.code !== 'credential-store-failed') throw error
        restorable.push(connection)
      }
    }
    this.#connections.restore(restorable)
    if (restorable.length !== stored.length) await this.persistConnections()
  }

  private async persistConnections(): Promise<void> {
    if (this.#connectionStore === undefined) return
    await this.#connectionStore.save(this.#connections.list())
  }
}

const handoffIdentity = {
  user: {
    id: 'handoff-pending',
    email: 'handoff-pending@invalid',
    name: null,
    role: 'handoff-pending',
    employeeId: null,
  },
  tenant: { id: 'handoff-pending', slug: 'handoff-pending', name: null, environmentId: null },
  permissions: [],
} as const
