import type { ExpenseFields } from '@oryh/ai-client-expenses'
import type { ConnectionId } from '@oryh/ai-client-foundation'

export type { ExpenseDraft, ExpenseFields } from '@oryh/ai-client-expenses'
// Request shapes name the connection themselves: a base from another package is one the typert
// generator does not resolve.
export interface ConnectionRequest {
  connectionId: ConnectionId
}
export interface DraftRequest extends ConnectionRequest {
  id: string
  revision: number
}
export interface SaveDraftRequest extends ConnectionRequest {
  id?: string
  revision?: number
  fields: ExpenseFields
}
/** An expense confirm carries its chat session, so the Host can find that session's norm verdict. */
export interface ConfirmExpenseRequest extends DraftRequest {
  token: string
  sessionId?: string
}
export interface UploadRequest extends ConnectionRequest {
  filename: string
  contentType: string
  contentBase64: string
}
export interface ExpenseOptions {
  categories: { name: string; title: string }[]
}
export interface AttachmentReceipt {
  id: string
  filename: string
  sha256: string
}
export interface ExpenseReviewStartRequest {
  sessionId: string
  draftId: string
}
