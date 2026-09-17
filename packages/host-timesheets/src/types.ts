import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { TimesheetAction } from '@oryh/ai-client-timesheets'

export type {
  TimesheetAction,
  TimesheetDetail,
  TimesheetFields,
  TimesheetHeader,
  TimesheetIntent,
  TimesheetLine,
  TimesheetOptions,
  TimesheetTodo,
} from '@oryh/ai-client-timesheets'
// Request shapes name the connection themselves: a base from another package is one the typert
// generator does not resolve.
export interface ConnectionRequest {
  connectionId: ConnectionId
}
export interface DraftRequest extends ConnectionRequest {
  id: string
  revision: number
}
export interface TimesheetDetailRequest extends ConnectionRequest {
  headerId: string
  todoId?: string
}
export interface TimesheetActionRequest extends ConnectionRequest {
  action: TimesheetAction
}
/** A timesheet confirm carries its chat session, so the Host can find that session's norm verdict. */
export interface ConfirmTimesheetRequest extends DraftRequest {
  token: string
  sessionId?: string
}
export interface TimesheetReviewStartRequest {
  sessionId: string
  headerId: string
}
