import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { OperationId } from '@oryh/ai-client-core/types'
import type {
  ConnectionId,
  DeviceAuthorizationId,
  OperationResultId,
  SavedOperationId,
} from '@oryh/ai-client-foundation'

export type {
  BeginConnectionView,
  ConnectionSummary,
  OperationDefinition,
  OryhOperationResult,
  PollConnectionView,
  SavedOperationView,
} from '@oryh/ai-client-core'

/** Every ORYH Remote fails the same way: a business code in the details, a safe message. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'oryh/business': { code: string }
  }
}

export interface ConnectRequest {
  origin: string
  clientName: string
}
/** Every domain request names the enterprise connection it runs on. */
export interface ConnectionRequest {
  connectionId: ConnectionId
}
export interface AuthorizationRequest {
  authorizationId: DeviceAuthorizationId
}
export interface OperationRequest extends ConnectionRequest {
  operationId: OperationId
}
export interface ResultRequest extends OperationRequest {
  resultId: OperationResultId
}
export interface SaveResultRequest extends ResultRequest {
  label: string
}
export interface SavedRequest extends ConnectionRequest {
  savedOperationId: SavedOperationId
}
/** One revision of a locally kept draft or intent. */
export interface DraftRequest extends ConnectionRequest {
  id: string
  revision: number
}
/** A confirm consumes the token the prepare step issued. */
export interface ConfirmDraftRequest extends DraftRequest {
  token: string
}
export interface SkillSyncRequest extends ConnectionRequest {
  force?: boolean
}

/** What this deployment lets the agent do beyond reading. The desktop client has both. */
export interface ChatCapabilities {
  readonly shell: boolean
  readonly writes: boolean
}
