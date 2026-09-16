import type { ConnectionId, DeviceAuthorizationId, OperationResultId, SavedOperationId } from '@oryh/ai-client-foundation'
import type { OperationId } from '@oryh/ai-client-core/types'
import type { ExpenseFields } from '@oryh/ai-client-expenses'
export type { BeginConnectionView, ConnectionSummary, OryhOperationResult, OperationDefinition, PollConnectionView, SavedOperationView } from '@oryh/ai-client-core'
export type { ExpenseDraft, ExpenseFields } from '@oryh/ai-client-expenses'
export interface ConnectRequest { origin: string; clientName: string }
export interface ConnectionRequest { connectionId: ConnectionId }
export interface AuthorizationRequest { authorizationId: DeviceAuthorizationId }
export interface OperationRequest extends ConnectionRequest { operationId: OperationId }
export interface ResultRequest extends OperationRequest { resultId: OperationResultId }
export interface SaveResultRequest extends ResultRequest { label: string }
export interface SavedRequest extends ConnectionRequest { savedOperationId: SavedOperationId }
export interface DraftRequest extends ConnectionRequest { id: string; revision: number }
export interface SaveDraftRequest extends ConnectionRequest { id?: string; revision?: number; fields: ExpenseFields }
export interface ConfirmDraftRequest extends DraftRequest { token: string }
/** A timesheet confirm carries its chat session, so the Host can find that session's norm verdict. */
export interface ConfirmTimesheetRequest extends ConfirmDraftRequest { sessionId?: string }
export interface UploadRequest extends ConnectionRequest { filename: string; contentType: string; contentBase64: string }
export interface ExpenseOptions { categories: { name: string; title: string }[] }
export interface AttachmentReceipt { id: string; filename: string; sha256: string }


import type {} from '@deepseek-ai/dsh-typert-protocol'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'oryh/business': { code: string } }
}

export type { TimesheetHeader, TimesheetTodo, TimesheetOptions, TimesheetDetail, TimesheetIntent } from '@oryh/ai-client-timesheets'
export interface TimesheetDetailRequest extends ConnectionRequest { headerId: string; todoId?: string }
export interface TimesheetActionRequest extends ConnectionRequest { action: import('@oryh/ai-client-timesheets').TimesheetAction }

export interface TodoDetailRequest extends ConnectionRequest { todoId: string }
export interface ChatClearRequest { sessionId: string }
export interface ChatSelection { sessionId: string; connectionId: ConnectionId; todoId?: string; timesheetPage?: string; manager?: boolean; homeOnly?: boolean; navigationId?: string; visibleTodos?: {id:string;title:string}[]; listRevision?:string }
export interface ChatContextView { document?:import('@oryh/ai-client-todos').TodoDocument; ready: boolean; title: string; message: string }
export type { TodoDocument } from '@oryh/ai-client-todos'

export interface TimesheetChatState {
  sessionId: string; connectionId: ConnectionId; pageKey: string; revision: number
  manager: boolean; headerId?: string; todoId?: string
  localEdits?: string
  navigationId?: string
  fields?: import('@oryh/ai-client-timesheets').TimesheetFields
}
export interface TimesheetChatPoll { sessionId: string; connectionId: ConnectionId; pageKey: string }
export interface TimesheetChatProposal {
  id: string; revision: number; action: import('@oryh/ai-client-timesheets').TimesheetAction
}

export interface ChatHomeRequest { sessionId:string; connectionId:ConnectionId }
/**
 * A menu entry a person made: one existing list, narrowed by filters the server applies.
 *
 * Stored by the Host in the Harness workspace the session belongs to, per enterprise identity, and
 * published to the page on the command stream. It grants nothing: opening it still needs the
 * underlying list's permission.
 */
export interface UserViewSummary { id:string; label:string; kind:import('@oryh/ai-client-records').RecordKind; filters:import('@oryh/ai-client-records').RecordFilters }

export interface ChatNavigation { id:string; expiresAt:number; target?:'todo'|'project'|'page'|'columns'|'filters'|'view'; /** A user view to open; not `ChatPageRequest.viewId`, which names a page instance. */ userViewId?:string; columns?:string[]; queryFields?:string[]; /** Values to fill into declared query fields and apply at once. */ queryValues?:Record<string,string>; productCode?:string;productIds?:string[];products?:import('@oryh/ai-client-records').ProductOption[]; page?:ChatPageRequest['page']; listRevision?:string; headerId?:string; todoId?:string; manager?:boolean; /** The unsaved timesheet form, as synced, that the agent may replace with `headerId`; the page replaces only a form still exactly this. */ discardForm?:string }

export interface ChatPageRequest extends ChatHomeRequest { viewId:string; revision:number; navigationId?:string; page:'my-open-todos'|'my-expense-claims'|'list-projects'|'timesheets'|'timesheet-approvals'|'settings'|import('@oryh/ai-client-records').RecordKind; context?:{key:string;title:string;detail:string;scope:string;content?:string;queryFields?:string[];/** Query-field values currently applied to the list. */queryValues?:Record<string,string>;productCode?:string;productIds?:string[];products?:import('@oryh/ai-client-records').ProductOption[];columns?:string[];availableColumns?:{id:string;label:string}[];view?:UserViewSummary} }

export type {ProjectFields,ProjectIntent,ProjectOptions} from '@oryh/ai-client-projects'
export interface ProjectPrepareRequest extends ConnectionRequest {fields:import('@oryh/ai-client-projects').ProjectFields}
export interface ProjectChatState extends ChatHomeRequest {pageKey:string;revision:number;navigationId?:string;fields:import('@oryh/ai-client-projects').ProjectFields;busy:boolean}
export interface ProjectChatProposal {id:string;revision:number;fields:import('@oryh/ai-client-projects').ProjectFields}

export type ProjectColumn='name'|'code'|'status'|'client'|'startDate'|'endDate'|'createdAt'|'updatedAt'

/** Every page command pending for one session. The Host republishes the whole set on each change. */
export interface CommandSnapshot {
  /** Navigation, column, filter, todo, project-open and timesheet-open commands share one slot. */
  navigation?: ChatNavigation
  /** Menu entries in this session's workspace for its enterprise identity; absent until first read. */
  userViews?: UserViewSummary[]
  /** Staged timesheet suggestion for the bound timesheet page. */
  timesheet?: TimesheetChatProposal
  /** Staged new-project field suggestion. */
  project?: ProjectChatProposal
  /** Where the pre-submit norm review stands, when one is running. */
  review?: SubmitReviewState
  /**
   * Moves when the agent may have changed ORYH data — a turn that ran a skill step through the shell.
   * Pages re-read what they show whenever `id` changes; nothing says what changed, by design.
   */
  serverChange?: { id: string; at: number }
}

/**
 * Pre-submit norm review, published so the submit dialog can show progress.
 *
 * `queued` and `reviewing` are distinguished by whether the injected request is still sitting in
 * the agent's inbox: present means a conversation turn is still ahead of it, gone means the review
 * turn itself is running. The transition is driven by `agent/status`, not polled. See docs/22.
 */
export interface SubmitReviewState {
  /** ORYH object type under review, as the tenant's workflow definition names it. */
  objectType: string
  /** What to call this document to a person, supplied by the page that started the review. */
  label: string
  /** The document this review is about; a review for another one is stale. */
  documentId: string
  status: 'queued' | 'reviewing' | 'passed' | 'flagged' | 'unavailable'
  /** The agent's own words when `flagged`; why the review could not run when `unavailable`. */
  message?: string
}

/** Opening frame of one stream generation, carrying the full pending set. */
export interface CommandBaseline { type:'baseline'; commands:CommandSnapshot }
/** Later frame; also the full set, so a consumer never replays deltas. */
export interface CommandUpdate { type:'update'; commands:CommandSnapshot }
/** Stream frame: exactly one `baseline` per generation, then `update`s. */
export type CommandFrame = CommandBaseline | CommandUpdate
