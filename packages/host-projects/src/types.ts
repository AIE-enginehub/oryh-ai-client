import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { ProjectFields } from '@oryh/ai-client-projects'

export type { ProjectFields, ProjectIntent, ProjectOptions } from '@oryh/ai-client-projects'
// Request shapes name the connection themselves: a base from another package is one the typert
// generator does not resolve.
export interface ConnectionRequest {
  connectionId: ConnectionId
}
export interface DraftRequest extends ConnectionRequest {
  id: string
  revision: number
}
export interface ConfirmDraftRequest extends DraftRequest {
  token: string
}
export interface ProjectPrepareRequest extends ConnectionRequest {
  fields: ProjectFields
}
export type ProjectColumn = 'name' | 'code' | 'status' | 'client' | 'startDate' | 'endDate' | 'createdAt' | 'updatedAt'
