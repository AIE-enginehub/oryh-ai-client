import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BeginConnectionView,
  ConnectionSummary,
  OperationDefinition,
  OryhOperationResult,
  PollConnectionView,
  SavedOperationView,
  SkillRefreshResult,
} from '@oryh/ai-client-core'
import { OryhClientRemoteAdapter } from '@oryh/ai-client-core'
import { activateDesktopProfile } from './desktop-profile.js'
import { RemoteCalls } from './remote-calls.js'
import type {
  AuthorizationRequest,
  ConnectionRequest,
  ConnectRequest,
  OperationRecordRequest,
  OperationRequest,
  ResultRequest,
  SavedRequest,
  SaveResultRequest,
  SkillSyncRequest,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhConnectionRemote: ConnectionRemote
    /** Where a browser signs out, on a deployment that holds the sign-in for it. Absent on the desktop. */
    oryhManagedSignOut: string
  }
}

/** Browser-only typed connection API: sign-in, verification, the registered read operations, skills. */
export class ConnectionRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhClient', 'oryhSkills']
  private readonly api: OryhClientRemoteAdapter
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhConnectionRemote', { namespace: 'oryh' })
    this.calls = new RemoteCalls(ctx, 'oryh')
    this.api = new OryhClientRemoteAdapter(ctx.oryhClient)
  }
  /**
   * Public deployment hint only; credentials never cross this Remote.
   *
   * `signOut` is the multi-user server's: there the person did not connect an enterprise themselves —
   * the deployment signed them in — so the workbench offers one way out instead of connecting and
   * disconnecting local credentials, and follows this path to take it.
   */
  @Remote('connectionDefaults') connectionDefaults(): {
    origin: string
    signOut?: string
    switchAccount?: string
    activeConnectionId?: string
  } {
    const managed = this.ctx.get('oryhManagedSignOut')
    // A single-user container whose login gateway lets its person hand it to another account of theirs
    // (deploy/local): the workbench offers that page instead of connecting a second account, which the
    // container's owner check refuses.
    const signOut = {
      ...(process.env.ORYH_DESKTOP_CONNECTION_ID ? { activeConnectionId: process.env.ORYH_DESKTOP_CONNECTION_ID } : {}),
      ...(managed ? { signOut: managed } : {}),
      ...(process.env.ORYH_ACCOUNT_SWITCH === '1' ? { switchAccount: '/oryh/switch' } : {}),
    }
    const value = process.env.ORYH_SERVER_ORIGIN?.trim()
    if (!value) return { origin: '', ...signOut }
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error('ORYH_SERVER_ORIGIN must be an HTTP(S) origin without credentials or a path')
    }
    return { origin: url.origin, ...signOut }
  }
  /** Verify before any native Profile selection; the browser supplies only an opaque connection id. */
  @Remote('activateProfile') activateProfile(request: ConnectionRequest): Promise<boolean> {
    return this.calls.call(async () => {
      await this.ctx.oryhClient.verifyConnection(request.connectionId)
      return activateDesktopProfile(request.connectionId)
    })
  }
  @Remote('listConnections') listConnections(): Promise<readonly ConnectionSummary[]> {
    return this.calls.call(() => this.ctx.oryhClient.listConnections())
  }
  @Remote('beginConnection') beginConnection(request: ConnectRequest): Promise<BeginConnectionView> {
    return this.calls.call(() => this.ctx.oryhClient.beginConnection(request.origin, request.clientName))
  }
  @Remote('pollConnection') pollConnection(request: AuthorizationRequest): Promise<PollConnectionView> {
    return this.calls.call(() => this.ctx.oryhClient.pollConnection(request.authorizationId))
  }
  @Remote('cancelConnection') cancelConnection(request: AuthorizationRequest): Promise<void> {
    return this.calls.call(() => this.ctx.oryhClient.cancelConnection(request.authorizationId))
  }
  @Remote('verifyConnection') verifyConnection(request: ConnectionRequest): Promise<ConnectionSummary> {
    return this.calls.call(() => this.ctx.oryhClient.verifyConnection(request.connectionId))
  }
  @Remote('listOperations') listOperations(): Promise<readonly OperationDefinition[]> {
    return this.calls.call(() => this.ctx.oryhClient.listOperations())
  }
  @Remote('execute') execute(request: OperationRequest): Promise<OryhOperationResult> {
    return this.calls.call(() => this.api.execute(request.connectionId, request.operationId))
  }
  /** One record of a list by id, for a page asked to open a record its list has not loaded. */
  @Remote('executeOne') executeOne(request: OperationRecordRequest): Promise<OryhOperationResult> {
    return this.calls.call(() => this.api.executeOne(request.connectionId, request.operationId, request.id))
  }
  @Remote('reuse') reuse(request: ResultRequest): Promise<OryhOperationResult> {
    return this.calls.call(() => this.api.reuse(request.connectionId, request.operationId, request.resultId))
  }
  @Remote('saveResult') saveResult(request: SaveResultRequest): Promise<SavedOperationView> {
    return this.calls.call(() =>
      this.ctx.oryhClient.saveResult(request.connectionId, request.operationId, request.resultId, request.label),
    )
  }
  @Remote('listSavedOperations') listSavedOperations(
    request: ConnectionRequest,
  ): Promise<readonly SavedOperationView[]> {
    return this.calls.call(() => this.ctx.oryhClient.listSavedOperations(request.connectionId))
  }
  @Remote('refreshSavedOperation') refreshSavedOperation(request: SavedRequest): Promise<OryhOperationResult> {
    return this.calls.call(() =>
      this.ctx.oryhClient.refreshSavedOperation(request.connectionId, request.savedOperationId),
    )
  }
  @Remote('disconnect') disconnect(request: ConnectionRequest): Promise<void> {
    return this.calls.call(() => this.ctx.oryhClient.disconnect(request.connectionId))
  }
  /** Refresh the authorized skill source for this connection. */
  @Remote('skillSync') skillSync(request: SkillSyncRequest): Promise<SkillRefreshResult> {
    return this.calls.call(() => this.ctx.oryhSkills.sync(request.connectionId, request.force === true))
  }
}
