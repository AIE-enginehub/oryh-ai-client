import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { PageId } from '@oryh/ai-client-pages'
import type { ProjectFields } from '@oryh/ai-client-projects'
import type { ProductOption, RecordFilters, RecordKind } from '@oryh/ai-client-records'
import type { TimesheetAction, TimesheetFields } from '@oryh/ai-client-timesheets'

// ── The business pane bridge ────────────────────────────────────────────────────────────────────
//
// One protocol joins the business pane to the Chat session, whatever page is showing. The page
// tells the Host what it shows (`PaneSync`), and the Host tells the page what the agent asked of it
// (`PaneFrame`). A request from the agent is a command on a lane; the page carries it out and says
// so in its next sync (`acks`), which is what settles the tool that issued it.

/** The session a pane belongs to, and the enterprise it works in. */
export interface PaneBindRequest {
  sessionId: string
  connectionId: ConnectionId
}
/** What binding answered: whether Chat now follows this pane, in words a page can show. */
export interface PaneBindView {
  ready: boolean
  message: string
}
export interface PaneUnbindRequest {
  sessionId: string
}
/** Drop the pre-submit review when the user skips it or the submission settles. */
export interface ReviewClearRequest {
  sessionId: string
}

/**
 * A menu entry a person made: one existing list, narrowed by filters the server applies.
 *
 * Stored by the Host in the Harness workspace the session belongs to, per enterprise identity, and
 * published to the page on the pane stream. It grants nothing: opening it still needs the
 * underlying list's permission.
 */
export interface UserViewSummary {
  id: string
  label: string
  kind: RecordKind
  filters: RecordFilters
}

/** What a page says about itself to the model: its title, its narrowing, and its live content. */
export interface PageContext {
  /** The page's own key for what it shows, e.g. `list-projects:list` or `timesheets:<id>`. */
  key: string
  title: string
  detail: string
  scope: string
  /** A JSON snapshot of what is visible: loading, error, filters, the rows on screen. */
  content?: string
  columns?: string[]
  availableColumns?: { id: string; label: string }[]
  queryFields?: string[]
  /** Query-field values currently applied to the list. */
  queryValues?: Record<string, string>
  productCode?: string
  productIds?: string[]
  products?: ProductOption[]
  /** Present when the list on screen is a menu entry the person made. */
  view?: UserViewSummary
}
/** The todo list as the pane shows it, in its own order, and the todo open in it. */
export interface TodoPaneContext {
  visibleTodos: { id: string; title: string }[]
  /** Changes with the visible order, so a position the agent read is only good for that order. */
  listRevision: string
  todoId?: string
}
/** The timesheet page: which document is open, and the unsaved form when one is being edited. */
export interface TimesheetPaneContext {
  manager: boolean
  headerId?: string
  todoId?: string
  fields?: TimesheetFields
  /** The page's transient editing state, serialised, so the Host can tell whether a line is open. */
  localEdits?: string
}
/** The new-project form, unsaved. */
export interface ProjectPaneContext {
  fields: ProjectFields
  busy: boolean
}
/**
 * Everything a page reports. The sections beyond the generic fields belong to specific pages; they
 * are declared here, on the wire type, so the generated codec admits them, and typed through the
 * shared contract packages rather than the plugins that fill them in.
 */
export interface PaneContext extends PageContext {
  todos?: TodoPaneContext
  timesheet?: TimesheetPaneContext
  project?: ProjectPaneContext
}
/** A command the page carried out. */
export interface PaneAck {
  lane: string
  id: string
}
/** One page instance's state, as of one revision. Every sync carries the whole of it. */
export interface PaneSync extends PaneBindRequest {
  /** The pane instance; a new one starts a new revision sequence. */
  instance: string
  /** Monotonic within an instance; a lower revision than the Host holds is stale and ignored. */
  revision: number
  page: PageId
  context?: PaneContext
  acks?: PaneAck[]
}

/** What the agent asks the pane to show. */
export interface PaneNavigation {
  target: 'page' | 'view' | 'columns' | 'filters' | 'todo' | 'project' | 'timesheet'
  page?: PageId
  /** A user view to open. */
  userViewId?: string
  columns?: string[]
  queryFields?: string[]
  /** Values to fill into declared query fields and apply at once. */
  queryValues?: Record<string, string>
  productCode?: string
  productIds?: string[]
  products?: ProductOption[]
  listRevision?: string
  todoId?: string
  headerId?: string
  manager?: boolean
  /** The unsaved timesheet form, as synced, that the agent may replace; the page replaces only a form still exactly this. */
  discardForm?: string
}
/** A form the agent filled for the person, staged for the page to apply. */
export type PaneFormProposal =
  | { kind: 'timesheet'; revision: number; action: TimesheetAction }
  | { kind: 'project'; revision: number; fields: ProjectFields }
/** A pending request to the page. One per lane and session; a newer one on the lane replaces it. */
export interface PaneCommand<Lane extends string = string, Payload = unknown> {
  lane: Lane
  id: string
  /** The page the command is for; a sync from another page withdraws it. */
  page?: PageId
  payload: Payload
  expiresAt: number
}
export type NavigationCommand = PaneCommand<'navigation', PaneNavigation>
export type FormCommand = PaneCommand<'form', PaneFormProposal>
export type AnyPaneCommand = NavigationCommand | FormCommand

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
/** State the Host publishes beside the commands: not requests, but facts the pane shows. */
export interface PaneState {
  /** Menu entries in this session's workspace for its enterprise identity; absent until first read. */
  userViews?: UserViewSummary[]
  /** Where the pre-submit norm review stands, when one is running. */
  review?: SubmitReviewState
  /**
   * Moves when the agent may have changed ORYH data — a turn that wrote through an ORYH tool or the
   * shell. Pages re-read what they show whenever `id` changes; nothing says what changed, by design.
   */
  serverChange?: { id: string; at: number }
}
/** Stream frame: exactly one `baseline` per generation, then `update`s; each carries the full set. */
export interface PaneFrame {
  type: 'baseline' | 'update'
  commands: AnyPaneCommand[]
  state: PaneState
}
