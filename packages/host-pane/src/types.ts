import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { PageId } from '@oryh/ai-client-pages'
import type { ProductOption, RecordFilters } from '@oryh/ai-client-records'

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
/**
 * A record the person asked to see by clicking its link in a Chat answer. The link is the record's page
 * in the ORYH console, so it names the record the console's way: by object type and id.
 */
export interface PaneOpenRecordRequest extends PaneBindRequest {
  /** The record's object type as the console writes it (`sales_order`), or its collection (`sales-orders`). */
  type: string
  id: string
}
/** Whether the pane showed it. When not, the page lets the link go where it points: the console. */
export interface PaneOpenRecordView {
  opened: boolean
  notice?: string
}
/**
 * A question the person asked from a page: 「问 AI」 on a record, or on an error the page showed. Their
 * click is the asking, so it goes to the session as their turn.
 */
export interface PaneAskRequest extends PaneBindRequest {
  question: string
  /**
   * What the question is about, when that is one row of a list rather than the page as a whole: the
   * page shows many, and "this one" would not say which.
   */
  subject?: PaneAskSubject
}
/** Share one of the person's own menu entries with their colleagues, or stop sharing it. */
export interface PaneShareViewRequest extends PaneBindRequest {
  userViewId: string
  shared: boolean
}
/** Take a copy of an entry a colleague shared into the person's own menu, theirs to change from then on. */
export interface PaneCopySharedViewRequest extends PaneBindRequest {
  sharedViewId: string
}
/**
 * What a copy came to. A menu entry is in the person's menu under `id` at once; a page is among their own
 * pages, and enters the menu once it has run.
 */
export interface PaneCopiedView {
  kind: 'menu' | 'page'
  id: string
  label: string
}
/** One record a question from a page is about. */
export interface PaneAskSubject {
  /** What the row is called on the page: an order number, a title. */
  title: string
  /** Its collection and id, where the page knows them, so the agent can read exactly that record. */
  resource?: string
  id?: string
}
/** The menu a connection has before any session is open. */
export interface PaneMenuRequest {
  connectionId: ConnectionId
}
/** Drop the pre-submit review when the user skips it or the submission settles. */
export interface ReviewClearRequest {
  sessionId: string
  connectionId: string
}

/** One column of a menu entry's list: the field a row carries, under the name a person reads. */
export interface UserViewColumn {
  field: string
  /** What the column is called; the field name itself when nobody gave it a better one. */
  label: string
}

/**
 * A menu entry a person made: one ORYH collection, narrowed by filters the server applies, shown the
 * way they asked for it.
 *
 * `collection` is a collection ORYH's own catalogue names — the same word its list path uses, e.g.
 * `sales-order-items`. This client keeps no list of what those are: the deployment publishes it, and
 * a collection added to ORYH next month is addressable the day its endpoint is.
 *
 * Stored by the Host in the Harness workspace the session belongs to, per enterprise identity, and
 * published to the page on the pane stream. It grants nothing: where the collection is one a built-in
 * page shows, opening it still needs that page's permission, and ORYH answers for the rest.
 */
export interface UserViewSummary {
  id: string
  label: string
  /**
   * `role` when the entry is one the person's permissions imply rather than one they made; `shared` when
   * a colleague made it and shared it. Neither is the person's to change or remove.
   */
  origin?: 'role' | 'shared'
  /** For a `shared` entry, the colleague who shared it, by name. */
  sharedBy?: string
  /** For one of the person's own, that they share it now. Said to the page with the menu; never stored. */
  shared?: boolean
  /** For a `role` entry, the permissions that imply it: the page drops it once none of them is held. */
  grants?: string[]
  collection: string
  filters: RecordFilters
  /** How to show it. Absent for an entry made before a person could choose, or when the rows decide. */
  display?: {
    /** Field whose value titles a row; the id when absent. */
    title?: string
    summary?: string
    date?: string
    columns: UserViewColumn[]
  }
}

/** What a page says about itself to the model: its title, its narrowing, and its live content. */
export interface PageContext {
  /** The page's own key for what it shows, e.g. `my-open-todos:list` or `sales-orders:<id>`. */
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
  /** Forms on the page that describe themselves, for `oryh_form_fill`. */
  forms?: PaneFormContext[]
  /**
   * Forms the page has that are not on screen, by what each is called: one behind a row's button is there
   * once the person opens that row. A page whose forms were all closed read as a page with none, and the
   * agent told the person it could not fill what it could have, a click later.
   */
  closedForms?: string[]
  /**
   * What the list on the page can be narrowed by where that is its own doing — a keyword, a status, a
   * span of dates over the rows it has loaded — and what each holds now, for `oryh_list_filter`. A list
   * queried through ORYH's own parameters says so with `queryFields` instead.
   */
  listFilter?: { fields: string[]; values: Record<string, string> }
  /**
   * The person has typed something on this page that is not saved. The Host then leaves the page where
   * it is unless they ask to see another: a page opened to answer a question, or to show what the agent
   * just wrote, once took the place of the form they were in the middle of (docs/56 §3).
   */
  unsaved?: boolean
  /**
   * The ORYH document this page is about, when it is about one: the timesheet behind an open approval
   * todo. The pane follows what the agent reads and writes, but not away from this — a call that names
   * it is the person working on what is in front of them, and the page re-reads to show what came of it.
   */
  subject?: { type: string; id: string }
}
/** The todo list as the pane shows it, in its own order, and the todo open in it. */
export interface TodoPaneContext {
  visibleTodos: { id: string; title: string }[]
  /** Changes with the visible order, so a position the agent read is only good for that order. */
  listRevision: string
  todoId?: string
}
/** What one field of a form a page describes holds: text as typed, or a tick. */
export type FormScalar = string | boolean
/** One row of a form's lines: column name to what the row holds there. */
export type FormLine = Record<string, FormScalar>
/** What a field holds: text, a tick, or — for lines — its rows, top to bottom. */
export type FormValue = FormScalar | FormLine[]
/** One column of a form's lines; a field of the form itself is this and may also be `lines`. */
export interface FormColumnSpec {
  name: string
  label: string
  /** How it is entered: text, a number, a date, a tick, one of `options`, or several lines of text. */
  type: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'textarea'
  required?: boolean
  /** The choices of a `select`: the value it holds, and what a person calls it. */
  options?: { value: string; label: string }[]
  /** The longest text the field takes, where the form has a limit of its own. */
  maxLength?: number
}
/** One field of such a form, as a person reads it. */
export interface FormFieldSpec extends Omit<FormColumnSpec, 'type'> {
  /** As a column's, or `lines`: rows the person adds and removes, each with the same `columns`. */
  type: FormColumnSpec['type'] | 'lines'
  /** For `lines`: what each row holds. */
  columns?: FormColumnSpec[]
  /** For `lines`: the fewest and the most rows the form takes. */
  min?: number
  max?: number
}
/**
 * A form on the page, described by the page so the agent can fill it.
 *
 * The timesheet, project and expense forms are each written into this bridge by name: their fields are
 * typed here, each has tools of its own, and a fourth form meant doing all of it again. A page that
 * describes its form this way needs none of that — the Host reads the description, checks a fill against
 * it, and hands the page the values (docs/56 §15). It is the page's unsaved form and nothing more:
 * saving and submitting stay the page's buttons, or the agent's own writing in the conversation.
 */
export interface PaneFormContext {
  /** The page's own key for the form, stable while the same form is on screen. */
  id: string
  /** What the form is called. */
  label: string
  fields: FormFieldSpec[]
  values: Record<string, FormValue>
  /** The form is sending or awaiting confirmation: a fill waits. */
  busy: boolean
  /** The last Chat fill it took: which command, the fields it applied, and those it kept as the person had them. */
  chat?: { id: string; applied: string[]; kept: string[] }
}
/**
 * Everything a page reports. The sections beyond the generic fields belong to specific pages; they
 * are declared here, on the wire type, so the generated codec admits them, and typed through the
 * shared contract packages rather than the plugins that fill them in.
 */
export interface PaneContext extends PageContext {
  todos?: TodoPaneContext
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
  /**
   * The browser's IANA time zone, e.g. `Asia/Shanghai`: what "today" is to the person at this pane. The
   * Host tells the agent the date in it, and its own tools take "today" from it (clock.ts).
   */
  timeZone?: string
}

/** What the agent asks the pane to show. */
export interface PaneNavigation {
  target: 'page' | 'view' | 'columns' | 'filters' | 'todo' | 'analysis' | 'record'
  page?: PageId
  /**
   * Bring the business view forward. On a narrow screen Chat and the business view take turns, and a
   * page the agent opens to answer must not take the person away from the reply; only what they asked
   * to see comes forward. Absent means it opens behind Chat.
   */
  reveal?: boolean
  /** A user view to open. */
  userViewId?: string
  /**
   * For `record`: the id of the record to open on `page`, whether or not the list there is showing it.
   * The page reads it if it has to, and reports it open by a context key ending in `:<id>`. On the
   * `collection` page — a menu entry's list — `userViewId` says which entry.
   */
  recordId?: string
  analysisId?: string
  columns?: string[]
  queryFields?: string[]
  /**
   * Values to fill into declared query fields and apply at once. For `filters`, sent without
   * `queryFields`, they are the conditions a read in Chat narrowed this list by: the page shows the
   * fields it has for them, applies those and ignores any it does not know (docs/56 §23).
   */
  queryValues?: Record<string, string>
  productCode?: string
  productIds?: string[]
  products?: ProductOption[]
  listRevision?: string
  todoId?: string
}
/** A form the agent filled for the person, staged for the page to apply. */
export type PaneFormProposal =
  /**
   * Some fields of a form the page described (`PaneFormContext`). Each is applied only while the form
   * still holds for it what the agent last read (`base`): what the person typed since is kept, and said so.
   */
  {
    kind: 'fields'
    revision: number
    form: string
    base: Record<string, FormValue>
    values: Record<string, FormValue>
  }
/** A pending request to the page. One per lane and session; a newer one on the lane replaces it. */
export interface PaneCommand<Lane extends string = string, Payload = unknown> {
  lane: Lane
  id: string
  /** The page the command is for; a sync from a third page withdraws it. */
  page?: PageId
  /**
   * The page the pane was on when this was issued. A command that moves the pane is answered from
   * where it started, so a sync from there is not the person navigating away from it.
   */
  from?: PageId
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
/** One record a turn wrote: its collection as the path names it (`sales-orders`), and its id. */
export interface WrittenRecord {
  collection: string
  id: string
}

export interface PaneState {
  /** Menu entries in this session's workspace for its enterprise identity; absent until first read. */
  userViews?: UserViewSummary[]
  /**
   * Menu entries this identity's permissions imply — a finance clerk's invoices and payments — beside the
   * pages this client ships. Not stored and not removable: they are what the role is. Absent until read.
   */
  roleViews?: UserViewSummary[]
  /**
   * Menu entries colleagues of this enterprise shared (`origin: 'shared'`): how each is made, never what it
   * showed — whoever opens one reads ORYH as themselves. Absent where the deployment keeps no library,
   * which is also how a page knows whether sharing is on offer at all.
   */
  sharedViews?: UserViewSummary[]
  /** Which of the person's own entries (`userViews`) they are sharing now, by id. Absent with `sharedViews`. */
  sharedOwn?: string[]
  /**
   * The deployment keeps a library and it has not been read yet: the menu is not whole until it has, and
   * a page restored to a colleague's entry must wait rather than take it for withdrawn.
   */
  sharedPending?: true
  /** Where the pre-submit norm review stands, when one is running. */
  review?: SubmitReviewState
  /**
   * Moves when the agent may have changed ORYH data — a turn that wrote through an ORYH tool or the
   * shell. Pages re-read what they show whenever `id` changes. `records` names the records the turn's
   * calls wrote, where a call said which: a page showing one of them points it out, so the person finds
   * what Chat just did. It is a hint and never the whole of what changed — a shell step names nothing.
   */
  serverChange?: { id: string; at: number; records?: WrittenRecord[] }
  /**
   * Where each custom page this Host changed stands, by page id: its version, and the run in progress or
   * last ended. A page on screen re-reads when its entry moves — after an edit or a run from Chat, too.
   */
  customPages?: Record<string, string>
  /**
   * The names — collections and object types — whose records the pane can show from a link in a Chat
   * answer. A link naming anything else is left to open where it points. Absent until the Host has said.
   */
  recordLinks?: string[]
}
/** Stream frame: exactly one `baseline` per generation, then `update`s; each carries the full set. */
export interface PaneFrame {
  type: 'baseline' | 'update'
  commands: AnyPaneCommand[]
  state: PaneState
}
