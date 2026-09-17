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
import { RemoteCalls } from './remote-calls.js'
import type {
  AuthorizationRequest,
  ConnectionRequest,
  ConnectRequest,
  OperationRequest,
  ResultRequest,
  SavedRequest,
  SaveResultRequest,
  SkillSyncRequest,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhConnectionRemote: ConnectionRemote
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
  /** Public deployment hint only; credentials never cross this Remote. */
  @Remote('connectionDefaults') connectionDefaults(): { origin: string } {
    const value = process.env.ORYH_SERVER_ORIGIN?.trim()
    if (!value) return { origin: '' }
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
    return { origin: url.origin }
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
