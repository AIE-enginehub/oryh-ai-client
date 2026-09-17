export interface ProjectFields {
  project_name: string
  project_code: string
  client: string
  start_date: string
  end_date: string
}
export interface ProjectOptions {
  canCreate: boolean
}
export interface ProjectIntent {
  id: string
  revision: number
  fields: ProjectFields
  state: 'review' | 'creating' | 'created' | 'unknown' | 'failed'
  token: string
  expiresAt: number
  message: string
  projectId?: string
}
export interface OryhProjectRemote {
  projectOptions(connectionId: string): Promise<ProjectOptions>
  projectPrepare(connectionId: string, fields: ProjectFields): Promise<ProjectIntent>
  projectConfirm(connectionId: string, id: string, revision: number, token: string): Promise<ProjectIntent>
  projectHistory(connectionId: string): Promise<ProjectIntent[]>
  projectReconcile(connectionId: string, id: string, revision: number): Promise<ProjectIntent>
}
