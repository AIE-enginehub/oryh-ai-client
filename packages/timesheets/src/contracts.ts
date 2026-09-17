/**
 * ORYH's own name for this document, which is what a workflow definition is keyed by.
 *
 * It lives in contracts, not in the service: the page needs it to match a review against the
 * document it is confirming, and the service is Node-only.
 */
export const TIMESHEET_OBJECT_TYPE = 'timesheet_header'

import { OryhClientError } from '@oryh/ai-client-foundation'
export interface TimesheetLine {
  id?: string
  work_date: string
  hours: number
  work_type: string
  project_id: string
  task: string
  notes: string
}
export interface TimesheetFields {
  period_start: string
  period_end: string
  source_report_text: string
  entries: TimesheetLine[]
}
export interface TimesheetHeader {
  id: string
  employee_id: string
  period_start: string
  period_end: string
  status: string
  source_report_text: string
}
export interface TimesheetEntry extends TimesheetLine {
  id: string
  projectName: string
  client: string
}
export interface TimesheetApproval {
  id: string
  round_no: number
  sequence_no: number
  action: string
  comment: string
  approver_id: string
  acted_at: string
}
export interface TimesheetDetail {
  revision?: string
  canEdit?: boolean
  header: TimesheetHeader
  entries: TimesheetEntry[]
  approval_records: TimesheetApproval[]
}
export interface TimesheetTodo {
  id: string
  entity_id: string
  title: string
  description: string
}
export interface TimesheetOptions {
  editableStates: string[]
  submitStates: string[]
  workTypes: { name: string; title: string }[]
  projects: { id: string; name: string }[]
  requirements: string[]
}
export interface TimesheetAction {
  kind: 'create' | 'update' | 'submit' | 'approve' | 'add-line' | 'edit-line' | 'delete-line'
  expectedRevision?: string
  headerId?: string
  todoId?: string
  entryId?: string
  fields?: TimesheetFields
  line?: TimesheetLine
  decision?: 'approved' | 'rejected' | 'returned'
  comment?: string
}
export interface TimesheetIntent {
  id: string
  revision: number
  action: TimesheetAction
  state: 'review' | 'executing' | 'unknown' | 'done' | 'failed'
  token: string
  expiresAt: number
  updatedAt: string
  message: string
  detail?: TimesheetDetail
  resultId?: string
}
export interface OryhTimesheetRemote {
  timesheetList(id: string): Promise<TimesheetHeader[]>
  timesheetQueue(id: string): Promise<TimesheetTodo[]>
  timesheetOptions(id: string): Promise<TimesheetOptions>
  timesheetDetail(id: string, headerId: string, todoId?: string): Promise<TimesheetDetail>
  timesheetHistory(id: string): Promise<TimesheetIntent[]>
  timesheetPrepare(id: string, action: TimesheetAction): Promise<TimesheetIntent>
  timesheetConfirm(
    id: string,
    intentId: string,
    revision: number,
    token: string,
    sessionId?: string,
  ): Promise<TimesheetIntent>
  timesheetReconcile(id: string, intentId: string, revision: number): Promise<TimesheetIntent>
}
export function timesheetError(message: string): OryhClientError {
  return new OryhClientError(message, 'timesheet-conflict')
}
export function validateTimesheet(fields: TimesheetFields): void {
  const date = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
  if (!date(fields.period_start) || !date(fields.period_end) || fields.period_start > fields.period_end)
    throw timesheetError('请选择有效的工时起止日期。')
  if (!fields.entries.length || fields.entries.length > 100 || fields.source_report_text.length > 10000)
    throw timesheetError('请输入 1–100 条工时明细，原始说明不超过 10000 字。')
  const totals = new Map<string, number>()
  for (const line of fields.entries) {
    if (!date(line.work_date) || line.work_date < fields.period_start || line.work_date > fields.period_end)
      throw timesheetError('每条工时日期必须在申报期间内。')
    if (!Number.isFinite(line.hours) || line.hours <= 0 || line.hours > 24)
      throw timesheetError('每条工时必须大于 0 且不超过 24 小时。')
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(line.work_type)) throw timesheetError('工时类型无效。')
    if (line.task.length > 200 || line.notes.length > 2000)
      throw timesheetError('任务不超过 200 字，备注不超过 2000 字。')
    totals.set(line.work_date, (totals.get(line.work_date) ?? 0) + line.hours)
  }
  if ([...totals.values()].some(n => n > 24 + 1e-9))
    throw timesheetError('同一天合计不能超过 24 小时，请核对原始记录。')
}
