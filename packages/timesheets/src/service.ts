import { createHash, randomUUID } from 'node:crypto'
import {
  type ConnectionId,
  connectionId,
  employeeScope,
  OryhClientError,
  type OryhOperation,
  pageOperation,
} from '@oryh/ai-client-foundation'
import { hasPermission, requirePage, requirePermission } from '@oryh/ai-client-pages'
import {
  timesheetError as fail,
  type OryhTimesheetRemote,
  TIMESHEET_OBJECT_TYPE,
  type TimesheetAction,
  type TimesheetDetail,
  type TimesheetHeader,
  type TimesheetIntent,
  type TimesheetLine,
  validateTimesheet,
} from './contracts.js'
import type { TimesheetRecord, TimesheetStore } from './store.js'

/**
 * The transport this service needs. Wider than a read-only domain: timesheets write, so
 * the request shape carries method, body and the replay opt-out. Declared structurally so
 * this package does not depend on the core.
 */
export interface TimesheetHttp {
  request(
    connectionId: ConnectionId,
    request: {
      readonly path: `/${string}`
      readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
      readonly body?: unknown
      readonly retryExpired?: boolean
      /** On the server, how this write was confirmed; the desktop transport ignores it. */
      readonly operation?: OryhOperation
    },
  ): Promise<unknown>
}

/** The connection facts this service reads; `ConnectionSummary` satisfies this shape. */
export interface TimesheetConnection {
  readonly origin: string
  readonly identity: {
    readonly permissions?: readonly string[]
    readonly user: { readonly id: string; readonly employeeId: string | null }
    readonly tenant: { readonly id: string }
  }
}

/** How long reference data (work types, projects, workflow rules) is kept before ORYH is asked again. */
const REFERENCE_TTL_MS = 5 * 60_000
/** Pages of one list read at a time, after the first has said how many there are. */
const PAGE_CONCURRENCY = 4
const MAX_PAGES = 1000

const str = (v: unknown) => (typeof v === 'string' ? v : '')
/**
 * Narrow an ORYH response fragment to an object.
 *
 * This used to be imported from the expense contracts, so a malformed timesheet response
 * reported an expense conflict. Extracting the domain made that cross-domain borrow
 * untenable, and the error is now a timesheet one. No test or consumer observed the old
 * code, so this is a deliberate correction rather than a silent behaviour change.
 * @param value - decoded response fragment.
 * @returns the value as a record.
 */
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('工时数据无效。')
  return value as Record<string, unknown>
}
const rows = (v: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(v)) throw fail('工时响应格式无效。')
  return v.map(object)
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const header = (r: Record<string, unknown>): TimesheetHeader => ({
  id: str(r.id),
  employee_id: str(r.employee_id),
  period_start: str(r.period_start),
  period_end: str(r.period_end),
  status: str(r.status),
  source_report_text: str(r.source_report_text),
})
const line = (r: Record<string, unknown>): TimesheetLine => ({
  work_date: str(r.work_date),
  hours: Number(r.hours),
  work_type: str(r.work_type),
  project_id: str(r.project_id),
  task: str(r.task),
  notes: str(r.notes),
})
const linePayload = (l: TimesheetLine) => ({
  work_date: l.work_date,
  hours: l.hours,
  work_type: l.work_type,
  project_id: l.project_id || null,
  task: l.task || null,
  notes: l.notes || null,
})
function viewDetail(d: Record<string, unknown>): TimesheetDetail {
  return {
    ...(str(d.revision) ? { revision: str(d.revision) } : {}),
    header: header(object(d.header)),
    entries: rows(d.entries).map(r => ({
      id: str(r.id),
      ...line(r),
      projectName: str(r.project_name_snapshot),
      client: str(r.client),
    })),
    approval_records: rows(d.approval_records).map(r => ({
      id: str(r.id),
      round_no: Number(r.round_no),
      sequence_no: Number(r.sequence_no),
      action: str(r.action),
      comment: str(r.comment),
      approver_id: str(r.approver_id),
      acted_at: str(r.acted_at),
    })),
  }
}
/** Browser Remote only. Confirmation is deliberately not a model-callable operation. */
export class TimesheetService implements OryhTimesheetRemote {
  readonly #reference = new Map<string, { at: number; value: Promise<unknown> }>()
  private pending: Promise<void> = Promise.resolve()
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.pending
    let release!: () => void
    this.pending = new Promise<void>(resolve => {
      release = resolve
    })
    await prior
    try {
      return await fn()
    } finally {
      release()
    }
  }
  constructor(
    private store: TimesheetStore,
    private http: TimesheetHttp,
    private connection: (id: string) => TimesheetConnection,
    private verify: (id: string) => Promise<TimesheetConnection>,
  ) {}
  private scope(id: string) {
    const c = this.connection(id)
    if (!c.identity.user.employeeId) throw fail('当前账号未关联员工。')
    return employeeScope(c)
  }
  private guard(id: string, scope: string) {
    if (this.scope(id) !== scope) throw fail('企业或员工身份已改变，请重新核对。')
  }
  private async get(id: string, path: `/${string}`) {
    const scope = this.scope(id)
    const r = object(await this.http.request(connectionId(id), { path }))
    this.guard(id, scope)
    return r
  }
  /**
   * Every row of a paged list. The first page says how many there are; the rest are read a few at a
   * time rather than one after another, and come back in page order.
   */
  private async list(id: string, path: `/${string}`) {
    const scope = this.scope(id)
    const pageOf = async (page: number) => {
      const b = await this.get(id, `${path}${path.includes('?') ? '&' : '?'}page=${page}&size=100`)
      this.guard(id, scope)
      return b
    }
    const first = await pageOf(1)
    const pages = Number(object(first.meta ?? {}).pages) || 1
    if (pages > MAX_PAGES) throw fail('数据过多，请联系管理员。')
    const result = [rows(first.data)]
    for (let next = 2; next <= pages; next += PAGE_CONCURRENCY) {
      const batch = Array.from({ length: Math.min(PAGE_CONCURRENCY, pages - next + 1) }, (_, i) => next + i)
      result.push(...(await Promise.all(batch.map(async page => rows((await pageOf(page)).data)))))
    }
    return result.flat()
  }
  /**
   * Reference data that changes rarely — work types, projects, the workflow's requirements and its
   * state machine — read once per enterprise identity and kept for a few minutes. `invalidate` drops
   * it when ORYH data may have changed under it (the agent wrote, or a turn ran the shell).
   */
  private cached<T>(id: string, key: string, load: () => Promise<T>): Promise<T> {
    const slot = `${this.scope(id)}\n${key}`
    const hit = this.#reference.get(slot)
    if (hit && Date.now() - hit.at < REFERENCE_TTL_MS) return hit.value as Promise<T>
    const value = load()
    this.#reference.set(slot, { at: Date.now(), value })
    // A failed read is not remembered: the next caller asks again.
    value.catch(() => {
      if (this.#reference.get(slot)?.value === value) this.#reference.delete(slot)
    })
    return value
  }
  /** Forget cached reference data, so the next read asks ORYH again. */
  invalidate(): void {
    this.#reference.clear()
  }
  async timesheetList(id: string) {
    requirePage((await this.verify(id)).identity, 'timesheets')
    const employee = this.connection(id).identity.user.employeeId
    return (await this.list(id, `/timesheet-headers?employee_id=${encodeURIComponent(employee ?? '')}`))
      .filter(r => r.employee_id === employee)
      .map(header)
  }
  private async todos(id: string) {
    const employee = this.connection(id).identity.user.employeeId
    return (
      await this.list(
        id,
        `/todos?employee_id=${encodeURIComponent(employee ?? '')}&status=open&entity_type=timesheet_header`,
      )
    ).filter(
      r =>
        r.employee_id === employee &&
        r.entity_type === 'timesheet_header' &&
        r.status === 'open' &&
        r.todo_type === 'approval',
    )
  }
  async timesheetQueue(id: string) {
    requirePage((await this.verify(id)).identity, 'timesheet-approvals')
    return (await this.todos(id)).map(r => ({
      id: str(r.id),
      entity_id: str(r.entity_id),
      title: str(r.title),
      description: str(r.description),
    }))
  }
  // `/type-options` returns the whole family and declares no page or size; ORYH answers 422 to either.
  async timesheetOptions(id: string) {
    await this.verify(id)
    const scope = this.scope(id)
    const [types, projects, definitions, permissions] = await Promise.all([
      this.cached(id, 'work-types', () =>
        this.get(id, '/type-options?family=work_type&status=active').then(b => rows(b.data)),
      ),
      this.cached(id, 'projects', () => this.list(id, '/projects')),
      this.cached(id, 'requirements', () =>
        this.list(id, '/workflow-definitions?entity_kind=builtin&object_type=timesheet_header'),
      ),
      this.permissions(id),
    ])
    this.guard(id, scope)
    return {
      ...permissions,
      workTypes: types.map(r => ({ name: str(r.name), title: str(r.title) || str(r.name) })),
      projects: projects.map(r => ({
        id: str(r.id),
        name: str(r.project_name) || str(r.name) || str(r.title) || str(r.code) || str(r.id),
      })),
      requirements: definitions.map(r => str(r.definition_text)).filter(Boolean),
    }
  }
  private async permissions(id: string) {
    const definitions = await this.cached(id, 'state-machine', () =>
      this.list(id, '/object-type-definitions?entity_kind=builtin&object_type=timesheet_header&status=active'),
    )
    const configured = definitions[0]?.state_machine
    const machine = object(
      configured ?? {
        states: ['draft', 'submitted', 'approved', 'rejected', 'returned'],
        transitions: { draft: ['submitted'], returned: ['submitted'] },
        editable_states: ['draft', 'returned'],
      },
    )
    const submitted = str(object(machine.roles ?? {}).submitted) || 'submitted'
    const transitions = object(machine.transitions ?? {})
    return {
      editableStates: Array.isArray(machine.editable_states)
        ? machine.editable_states.filter((v): v is string => typeof v === 'string')
        : ['draft', 'returned'],
      submitStates: Object.keys(transitions).filter(
        s => s !== submitted && Array.isArray(transitions[s]) && (transitions[s] as unknown[]).includes(submitted),
      ),
    }
  }
  private async detail(id: string, headerId: string, todoId?: string) {
    const scope = this.scope(id)
    if (!headerId) throw fail('请选择工时单。')
    let todo: Record<string, unknown> | undefined
    if (todoId) {
      todo = (await this.todos(id)).find(r => r.id === todoId && r.entity_id === headerId)
      if (!todo) throw fail('此审批待办已结束或未分配给您。')
    }
    const d = object((await this.get(id, `/timesheet-headers/${encodeURIComponent(headerId)}/detail`)).data)
    const h = object(d.header)
    if (h.id !== headerId || (!todo && h.employee_id !== this.connection(id).identity.user.employeeId))
      throw fail('工时单不属于当前员工。')
    if (todo && h.employee_id === this.connection(id).identity.user.employeeId) throw fail('不能审批自己的工时单。')
    this.guard(id, scope)
    return { d, todo }
  }
  async timesheetDetail(id: string, headerId: string, todoId?: string) {
    await this.verify(id)
    const scope = this.scope(id)
    requirePage(this.connection(id).identity, todoId ? 'timesheet-approvals' : 'timesheets')
    const d = viewDetail((await this.detail(id, headerId, todoId)).d)
    // The grants are the ones `verify` just confirmed with ORYH; asking `/auth/me` a second time here
    // told the page nothing the verified identity does not already say, and ORYH decides writes anyway.
    const rules = await this.permissions(id)
    this.guard(id, scope)
    return {
      ...d,
      canEdit:
        !todoId &&
        d.header.employee_id === this.connection(id).identity.user.employeeId &&
        rules.editableStates.includes(d.header.status) &&
        hasPermission(this.connection(id).identity, 'timesheet.submit_own'),
    }
  }
  private view(r: TimesheetRecord): TimesheetIntent {
    const { scope: _s, digest: _d, payload: _p, path: _path, method: _m, ...v } = r
    return v.state === 'executing' ? { ...v, state: 'unknown', message: '写入结果尚未确认，请先核对。' } : v
  }
  // Await verification like every sibling read: a concurrent re-verification revokes the
  // registry entry until `/auth/me` returns, and a bare `scope()` would throw inside that window.
  async timesheetHistory(id: string) {
    await this.verify(id)
    const scope = this.scope(id)
    const r = await this.store.list()
    this.guard(id, scope)
    return r
      .filter(r => r.scope === scope)
      .map(r => this.view(r))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  private async next(id: string, r: TimesheetRecord, changes: Partial<TimesheetRecord>) {
    this.guard(id, r.scope)
    const n = { ...r, ...changes, revision: r.revision + 1, updatedAt: new Date().toISOString() }
    await this.store.append(n, r.revision)
    this.guard(id, r.scope)
    return n
  }
  private async read(id: string, intentId: string, revision: number) {
    const scope = this.scope(id)
    const r = (await this.store.list()).find(r => r.scope === scope && r.id === intentId && r.revision === revision)
    this.guard(id, scope)
    if (!r) throw fail('操作已改变，请刷新。')
    return r
  }
  private async context(id: string, a: TimesheetAction) {
    const { d, todo } = await this.detail(id, a.headerId ?? '', a.kind === 'approve' ? a.todoId : undefined)
    if (a.kind === 'approve' && !todo) throw fail('审批必须关联您自己的待办。')
    const permissions = await this.permissions(id)
    if (a.kind === 'submit' && !permissions.submitStates.includes(str(object(d.header).status)))
      throw fail('当前单据状态不允许提交审批。')
    if (
      ['update', 'add-line', 'edit-line', 'delete-line'].includes(a.kind) &&
      !permissions.editableStates.includes(str(object(d.header).status))
    )
      throw fail('当前单据状态不允许修改明细。')
    return { d, todo, digest: hash({ d, todo, permissions }) }
  }
  async timesheetPrepare(id: string, input: TimesheetAction) {
    await this.verify(id)
    requirePermission(
      this.connection(id).identity,
      input.kind === 'approve' ? 'approval.record' : 'timesheet.submit_own',
    )
    const scope = this.scope(id),
      action = structuredClone(input),
      intentId = randomUUID()
    const previous = await this.store.list()
    if (
      previous.some(
        r =>
          r.scope === scope &&
          ['unknown', 'executing'].includes(r.state) &&
          (action.kind === 'create'
            ? r.action.kind === 'create' &&
              r.action.fields?.period_start === action.fields?.period_start &&
              r.action.fields?.period_end === action.fields?.period_end
            : r.action.headerId === action.headerId),
      )
    )
      throw fail('这张工时单有尚未确认的写入，请先核对执行记录。')
    let path: `/${string}` = '/timesheet-headers',
      method: TimesheetRecord['method'] = 'POST',
      payload: Record<string, unknown>,
      digest = '',
      detail: TimesheetDetail | undefined
    if (action.kind === 'create') {
      if (!action.fields) throw fail('缺少工时明细。')
      validateTimesheet(action.fields)
      const f = action.fields
      payload = {
        employee_id: this.connection(id).identity.user.employeeId,
        period_start: f.period_start,
        period_end: f.period_end,
        source_report_text: f.source_report_text,
        custom_fields: { oryh_client_intent_id: intentId },
        entries: f.entries.map(linePayload),
      }
      const check = object(
        await this.http.request(connectionId(id), {
          path: '/timesheet-headers?validate_only=true',
          method: 'POST',
          body: payload,
          retryExpired: false,
        }),
      )
      if (object(check.meta).validate_only !== true || object(check.meta).written !== false)
        throw fail('服务端未确认这是预校验，请停止并核对。')
    } else {
      const context = await this.context(id, action)
      digest = context.digest
      detail = viewDetail(context.d)
      if (action.kind === 'update') {
        if (!action.fields) throw fail('缺少整单工时内容。')
        if (!detail.revision)
          throw fail('此 ORYH 服务尚未支持整单更新，请部署工时整单保存接口。当前修改仍保留，未写入任何数据。')
        if (!action.expectedRevision || action.expectedRevision !== detail.revision)
          throw fail('工时已被其他页面修改，请重新打开后编辑。当前修改未保存。')
        validateTimesheet(action.fields)
        const ids = action.fields.entries.flatMap(l => (l.id ? [l.id] : []))
        if (new Set(ids).size !== ids.length || ids.some(id => !detail!.entries.some(e => e.id === id)))
          throw fail('明细编号无效，请重新读取工时。')
        path = `/timesheet-headers/${encodeURIComponent(detail.header.id)}/save`
        payload = {
          ...action.fields,
          expected_revision: action.expectedRevision,
          intent_id: intentId,
          entries: action.fields.entries.map(l => ({ ...linePayload(l), ...(l.id ? { id: l.id } : {}) })),
        }
        const check = object(
          await this.http.request(connectionId(id), {
            path: `${path}?validate_only=true`,
            method: 'POST',
            body: payload,
            retryExpired: false,
          }),
        )
        if (object(check.meta).validate_only !== true || object(check.meta).written !== false)
          throw fail('服务端未确认这是预校验，请停止并核对。')
      } else if (action.kind === 'submit') {
        validateTimesheet({ ...detail.header, entries: detail.entries })
        path = `/timesheet-headers/${encodeURIComponent(detail.header.id)}/submit`
        payload = { source: 'web' }
      } else if (action.kind === 'approve') {
        if (
          !['approved', 'rejected', 'returned'].includes(action.decision ?? '') ||
          !action.comment?.trim() ||
          action.comment.length > 2000
        )
          throw fail('请选择审批意见，并填写不超过 2000 字的说明。')
        const metadata = object(context.todo!.metadata ?? {}),
          history = rows(context.d.approval_records)
        const latestRound = Math.max(0, ...history.filter(r => r.action === 'submitted').map(r => Number(r.round_no)))
        const round = Number(metadata.round_no),
          sequence =
            metadata.sequence_no === undefined
              ? Math.max(1, ...history.filter(r => r.round_no === round).map(r => Number(r.sequence_no))) + 1
              : Number(metadata.sequence_no)
        if (
          !Number.isSafeInteger(round) ||
          round < 1 ||
          round !== latestRound ||
          !Number.isSafeInteger(sequence) ||
          sequence < 2
        )
          throw fail('待办审批轮次无效或已过期，请由流程管理员检查。')
        if (
          history.some(
            r =>
              r.round_no === round &&
              r.sequence_no === sequence &&
              ['approved', 'rejected', 'returned'].includes(str(r.action)),
          )
        )
          throw fail('该审批节点已有决定，请刷新待办。')
        path = '/approval-records'
        payload = {
          entity_type: 'timesheet_header',
          entity_id: detail.header.id,
          round_no: round,
          sequence_no: sequence,
          action: action.decision,
          comment: action.comment.trim(),
          source: 'web',
          metadata: { oryh_client_intent_id: intentId },
          ...(typeof metadata.approver_role === 'string' ? { approver_role: metadata.approver_role } : {}),
        }
      } else {
        const entry = detail.entries.find(e => e.id === action.entryId)
        if (action.kind !== 'add-line' && !entry) throw fail('工时明细已不存在。')
        if (action.kind === 'delete-line') {
          path = `/timesheet-entries/${encodeURIComponent(entry!.id)}`
          method = 'DELETE'
          payload = {}
        } else {
          if (!action.line) throw fail('缺少工时明细。')
          if (action.kind === 'edit-line' && action.line.work_date !== entry!.work_date)
            throw fail('已保存的明细日期不可直接修改，请删除该行后重新录入。')
          validateTimesheet({
            ...detail.header,
            entries: [...detail.entries.filter(e => e.id !== action.entryId), action.line],
          })
          payload = { ...linePayload(action.line), custom_fields: { oryh_client_intent_id: intentId } }
          if (action.kind === 'add-line') {
            path = '/timesheet-entries'
            payload.header_id = detail.header.id
            payload.employee_id = this.connection(id).identity.user.employeeId
          } else {
            path = `/timesheet-entries/${encodeURIComponent(entry!.id)}`
            method = 'PATCH'
            delete payload.work_date
            delete payload.custom_fields
          }
        }
      }
    }
    this.guard(id, scope)
    const r: TimesheetRecord = {
      id: intentId,
      revision: 1,
      scope,
      action,
      state: 'review',
      token: randomUUID(),
      expiresAt: Date.now() + 300000,
      updatedAt: new Date().toISOString(),
      message: '请核对后确认。',
      digest,
      payload,
      path,
      method,
      ...(detail ? { detail } : {}),
    }
    await this.store.append(r, 0)
    this.guard(id, scope)
    return this.view(r)
  }
  /**
   * Refuse a confirm the pre-submit norm review has not cleared.
   *
   * The verdict lives in the Host's chat layer, which this package must not depend on, so the Host
   * installs the check here instead. It sits in the service rather than in the page because a
   * disabled button is a suggestion: the Remote is reachable without it.
   * @param gate - throws when the action may not be confirmed; no-op for actions it does not cover.
   */
  setSubmitGate(gate: (objectType: string, documentId: string | undefined, sessionId?: string) => void) {
    this.gate = gate
  }
  private gate?: (objectType: string, documentId: string | undefined, sessionId?: string) => void
  /** Asked before every submit: no definition for this object type means nothing to check. */
  setWorkflowLookup(governs: (id: string, objectType: string) => Promise<boolean>) {
    this.governs = governs
  }
  private governs?: (id: string, objectType: string) => Promise<boolean>
  timesheetConfirm(id: string, intentId: string, revision: number, token: string, sessionId?: string) {
    return this.serialize(() => this.confirm(id, intentId, revision, token, sessionId))
  }
  private async confirm(id: string, intentId: string, revision: number, token: string, sessionId?: string) {
    await this.verify(id)
    let r = await this.read(id, intentId, revision)
    if (
      (await this.store.list()).some(
        other =>
          other.id !== r.id &&
          other.scope === r.scope &&
          ['unknown', 'executing'].includes(other.state) &&
          (r.action.kind === 'create'
            ? other.action.kind === 'create' &&
              other.action.fields?.period_start === r.action.fields?.period_start &&
              other.action.fields?.period_end === r.action.fields?.period_end
            : other.action.headerId === r.action.headerId),
      )
    )
      throw fail('该单据有未确认的操作，请先核对执行记录。')
    requirePermission(
      this.connection(id).identity,
      r.action.kind === 'approve' ? 'approval.record' : 'timesheet.submit_own',
    )
    if (r.action.kind === 'submit' && (await (this.governs?.(id, TIMESHEET_OBJECT_TYPE) ?? Promise.resolve(false))))
      this.gate?.(TIMESHEET_OBJECT_TYPE, r.action.headerId, sessionId)
    if (r.state !== 'review' || r.token !== token || r.expiresAt < Date.now())
      throw fail('确认已过期或已使用，请重新核对。')
    if (r.action.kind !== 'create' && (await this.context(id, r.action)).digest !== r.digest)
      throw fail('工时内容或审批待办已改变，请重新核对。')
    if (r.expiresAt < Date.now()) throw fail('确认已过期，请重新核对。')
    r = await this.next(id, r, { state: 'executing', token: '', message: '正在执行，请勿重复操作。' })
    try {
      // The intent id names this one write: a server admits it once, and records what came of it.
      const response = await this.http.request(connectionId(id), {
        path: r.path,
        method: r.method,
        body: r.payload,
        retryExpired: false,
        operation: pageOperation(r.id, { method: r.method, path: r.path, body: r.payload }, sha256),
      })
      const data = r.method === 'DELETE' ? {} : object(object(response).data)
      if (r.method !== 'DELETE' && !str(data.id)) throw fail('服务端未返回操作编号。')
      if (r.action.kind === 'approve' && object(data.metadata ?? {}).oryh_client_intent_id !== r.id)
        throw fail('服务端已有其他审批事实，请核对。')
      return this.view(
        await this.next(id, r, {
          state: 'done',
          resultId: str(data.id) || r.action.entryId || '',
          message:
            r.action.kind === 'approve'
              ? '已记录经理意见，待办由服务端处理；单据状态由审批流程推进。'
              : r.action.kind === 'submit'
                ? '已提交审批。'
                : '工时已保存。',
        }),
      )
    } catch (error) {
      const rejected =
        error instanceof OryhClientError &&
        error.status !== undefined &&
        [400, 401, 403, 404, 409, 422].includes(error.status)
      return this.view(
        await this.next(
          id,
          r,
          rejected
            ? {
                state: 'failed',
                message: `服务端拒绝了本次操作（${error.status}），未自动重试。请核对单据状态、权限和明细后重新操作。`,
              }
            : { state: 'unknown', message: '写入未获得确定结果，请核对。不会自动重发。' },
        ),
      )
    }
  }
  timesheetReconcile(id: string, intentId: string, revision: number) {
    return this.serialize(() => this.reconcile(id, intentId, revision))
  }
  private async reconcile(id: string, intentId: string, revision: number) {
    await this.verify(id)
    const r = await this.read(id, intentId, revision)
    if (!['unknown', 'executing'].includes(r.state)) throw fail('只有未确认的操作需要核对。')
    let found = ''
    if (r.action.kind === 'create') {
      const employee = this.connection(id).identity.user.employeeId
      const matches = (
        await this.list(id, `/timesheet-headers?employee_id=${encodeURIComponent(employee ?? '')}`)
      ).filter(h => h.employee_id === employee && object(h.custom_fields ?? {}).oryh_client_intent_id === r.id)
      if (matches.length === 1) found = str(matches[0]!.id)
    } else {
      // Own approval may already have closed its todo. Scope is bound to the durable reviewed record.
      const d = object((await this.get(id, `/timesheet-headers/${encodeURIComponent(r.action.headerId!)}/detail`)).data)
      if (object(d.header).id !== r.action.headerId || object(d.header).employee_id !== r.detail?.header.employee_id)
        throw fail('单据身份与核对记录不符。')
      if (r.action.kind === 'approve')
        found = str(rows(d.approval_records).find(a => object(a.metadata ?? {}).oryh_client_intent_id === r.id)?.id)
      if (
        r.action.kind === 'update' &&
        object(object(d.header).custom_fields ?? {}).oryh_client_save_intent_id === r.id
      )
        found = r.action.headerId!
      if (r.action.kind === 'add-line')
        found = str(rows(d.entries).find(a => object(a.custom_fields ?? {}).oryh_client_intent_id === r.id)?.id)
      if (r.action.kind === 'delete-line' && !rows(d.entries).some(e => e.id === r.action.entryId))
        found = r.action.entryId!
      if (
        r.action.kind === 'edit-line' &&
        rows(d.entries).some(e => e.id === r.action.entryId && hash(line(e)) === hash(r.action.line))
      )
        found = r.action.entryId!
      if (r.action.kind === 'submit') {
        const before = new Set(r.detail!.approval_records.map(a => a.id))
        if (rows(d.approval_records).some(a => a.action === 'submitted' && !before.has(str(a.id))))
          found = r.action.headerId!
      }
    }
    return this.view(
      await this.next(
        id,
        r,
        found
          ? { state: 'done', resultId: found, message: '已核对到服务端记录。' }
          : { state: 'unknown', message: '尚未找到足以确认的记录。请在 ORYH 核对或联系管理员；不要重复执行。' },
      ),
    )
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
