import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OryhProjectRemote, ProjectIntent, ProjectOptions } from '@oryh/ai-client-projects'
import { RemoteCalls } from '@oryh/dsh-connection'
import type { ConfirmDraftRequest, ConnectionRequest, DraftRequest, ProjectPrepareRequest } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhProjects: OryhProjectRemote
    oryhProjectsRemote: ProjectsRemote
  }
}

/** Browser-only project API; creation is prepared and confirmed by the page, never by a model tool. */
export class ProjectsRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhProjects']
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhProjectsRemote', { namespace: 'oryhProjects' })
    this.calls = new RemoteCalls(ctx, 'oryhProjects')
  }
  @Remote('projectOptions') projectOptions(r: ConnectionRequest): Promise<ProjectOptions> {
    return this.calls.call(() => this.ctx.oryhProjects.projectOptions(r.connectionId))
  }
  @Remote('projectPrepare') projectPrepare(r: ProjectPrepareRequest): Promise<ProjectIntent> {
    return this.calls.call(() => this.ctx.oryhProjects.projectPrepare(r.connectionId, r.fields))
  }
  @Remote('projectConfirm') projectConfirm(r: ConfirmDraftRequest): Promise<ProjectIntent> {
    return this.calls.call(() => this.ctx.oryhProjects.projectConfirm(r.connectionId, r.id, r.revision, r.token))
  }
  @Remote('projectHistory') projectHistory(r: ConnectionRequest): Promise<ProjectIntent[]> {
    return this.calls.call(() => this.ctx.oryhProjects.projectHistory(r.connectionId))
  }
  @Remote('projectReconcile') projectReconcile(r: DraftRequest): Promise<ProjectIntent> {
    return this.calls.call(() => this.ctx.oryhProjects.projectReconcile(r.connectionId, r.id, r.revision))
  }
}
