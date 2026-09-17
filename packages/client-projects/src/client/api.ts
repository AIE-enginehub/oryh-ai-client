import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { OryhProjectRemote } from '@oryh/ai-client-projects'
import { connectionRequest, unwrap } from '@oryh/dsh-client-frame/client'
import type {} from '@oryh/dsh-projects/remote'
import { createContext, useContext } from 'react'

/** The projects namespace (`oryhProjects`), as the page calls it. */
export type ProjectsApi = OryhProjectRemote
export const ProjectsApiContext = createContext<ProjectsApi | undefined>(undefined)
export function useProjectsApi(): ProjectsApi {
  const api = useContext(ProjectsApiContext)
  if (!api) throw new Error('ORYH projects Remote is not mounted')
  return api
}
export function createProjectsApi(remote: ClientRemote): ProjectsApi {
  const projects = remote.oryhProjects
  const connection = connectionRequest
  return {
    projectOptions: id => unwrap(projects.projectOptions(connection(id))),
    projectPrepare: (id, fields) => unwrap(projects.projectPrepare({ ...connection(id), fields })),
    projectConfirm: (id, key, revision, token) =>
      unwrap(projects.projectConfirm({ ...connection(id), id: key, revision, token })),
    projectHistory: id => unwrap(projects.projectHistory(connection(id))),
    projectReconcile: (id, key, revision) =>
      unwrap(projects.projectReconcile({ ...connection(id), id: key, revision })),
  }
}
