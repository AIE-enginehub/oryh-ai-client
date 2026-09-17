import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OryhUser } from '@oryh/ai-client-core'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { type PageId, requirePage, requirePermission } from '@oryh/ai-client-pages'
import {
  type OryhTimesheetRemote,
  type TimesheetAction,
  type TimesheetDetail,
  type TimesheetFields,
  type TimesheetHeader,
  type TimesheetLine,
  type TimesheetOptions,
  type TimesheetTodo,
  validateTimesheet,
} from '@oryh/ai-client-timesheets'
import { TIMESHEET_OBJECT_TYPE } from '@oryh/ai-client-timesheets/contracts'
import { type PaneService, type PaneSession, type SubmitReview, textOutput } from '@oryh/dsh-pane'
import type { TimesheetPaneContext } from '@oryh/dsh-pane/types'
import { z } from 'zod'

const line = z
  .object({
    id: z.string().optional(),
    work_date: z.string(),
    hours: z.number(),
    work_type: z.string(),
    project_id: z.string(),
    project_name: z.string(),
    task: z.string().max(200),
    notes: z.string().max(2000),
  })
  .strict()
const fields = z
  .object({
    period_start: z.string(),
    period_end: z.string(),
    source_report_text: z.string().max(10000),
    entries: z.array(line).min(1).max(100),
  })
  .strict()
/**
 * The page's own shape. `project_name` is the tool's assertion about its id resolution, not a form
 * field, so it must not reach the page; this schema strips it from both sides of the receipt
 * comparison, which would otherwise compare a page snapshot against a differently-shaped request.
 */
const pageFields = z.object({
  period_start: z.string(),
  period_end: z.string(),
  source_report_text: z.string(),
  entries: z.array(
    z.object({
      id: z.string().optional(),
      work_date: z.string(),
      hours: z.number(),
      work_type: z.string(),
      project_id: z.string(),
      task: z.string(),
      notes: z.string(),
    }),
  ),
})
const lineSnapshot = ({ project_name: _asserted, id, ...entry }: z.infer<typeof line>): TimesheetLine => ({
  ...entry,
  ...(id ? { id } : {}),
})
const formSnapshot = (value: z.infer<typeof fields>): TimesheetFields => ({
  period_start: value.period_start,
  period_end: value.period_end,
  source_report_text: value.source_report_text,
  entries: value.entries.map(lineSnapshot),
})
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), fields }).strict(),
  z.object({ kind: z.literal('update'), headerId: z.string(), fields }).strict(),
  z.object({ kind: z.literal('add-line'), headerId: z.string(), line }).strict(),
  z.object({ kind: z.literal('edit-line'), headerId: z.string(), entryId: z.string(), line }).strict(),
  z.object({ kind: z.literal('delete-line'), headerId: z.string(), entryId: z.string() }).strict(),
])
/** Drop the tool's name assertions so only page-shaped data is stored or published. */
function pageAction(value: z.infer<typeof actionSchema>): TimesheetAction {
  if (value.kind === 'update') return { kind: value.kind, headerId: value.headerId, fields: formSnapshot(value.fields) }
  if (value.kind === 'create') return { kind: value.kind, fields: formSnapshot(value.fields) }
  if (value.kind === 'add-line') return { kind: value.kind, headerId: value.headerId, line: lineSnapshot(value.line) }
  if (value.kind === 'edit-line')
    return { kind: value.kind, headerId: value.headerId, entryId: value.entryId, line: lineSnapshot(value.line) }
  return value
}
/**
 * What the page actually holds, read from the synced form rather than echoed from the request.
 *
 * A content-free receipt let the model restate its own intent unchallenged, so a wrong project
 * read back as a confident success. Naming the project and the hours the page really has is what
 * makes that contradiction visible in the trajectory and to the user.
 */
function appliedSummary(form: TimesheetFields, projects: readonly { id: string; name: string }[]) {
  const daily = new Map<string, number>()
  for (const l of form.entries) daily.set(l.work_date, (daily.get(l.work_date) ?? 0) + l.hours)
  return {
    period_start: form.period_start,
    period_end: form.period_end,
    total_hours: form.entries.reduce((sum, l) => sum + l.hours, 0),
    daily_hours: [...daily]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([work_date, hours]) => ({ work_date, hours })),
    entries: form.entries.map(l => ({
      work_date: l.work_date,
      hours: l.hours,
      work_type: l.work_type,
      project_id: l.project_id,
      project_name: l.project_id ? (projects.find(p => p.id === l.project_id)?.name ?? '（不在当前可用项目中）') : '',
      task: l.task,
    })),
  }
}
const lineSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '已有明细保留原编号；新增明细不传' },
    work_date: { type: 'string', required: true },
    hours: { type: 'number', required: true },
    work_type: { type: 'string', required: true },
    project_id: { type: 'string', required: true, description: '不关联项目时必须为空字符串' },
    project_name: {
      type: 'string',
      required: true,
      description:
        'project_id 对应项目的名称，逐字取自 read 返回的 projects；与编号不一致会被拒绝。不关联项目时必须为空字符串',
    },
    task: { type: 'string', required: true },
    notes: { type: 'string', required: true },
  },
} as const
const fieldsSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    period_start: { type: 'string', required: true },
    period_end: { type: 'string', required: true },
    source_report_text: { type: 'string', required: true },
    entries: { type: 'array', required: true, items: lineSpec },
  },
} as const
const actionSpec = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['create', 'update', 'add-line', 'edit-line', 'delete-line'] },
    fields: fieldsSpec,
    headerId: { type: 'string' },
    entryId: { type: 'string' },
    line: lineSpec,
  },
} as const
const fail = (text: string) => new OryhClientError(text, 'request-failed')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const TIMESHEET_PAGES: readonly PageId[] = ['timesheets', 'timesheet-approvals']

/** A timesheet page on screen: the pane as captured, and its timesheet section when the page reported one. */
interface TimesheetPage {
  session: PaneSession
  page: PageId
  manager: boolean
  form: TimesheetPaneContext | undefined
}

/**
 * The timesheet page in the business pane, for the agent: reading what is open, filling the unsaved
 * form, opening a timesheet or the blank form, and finding one to open.
 *
 * Saving, submitting and approving are not here: the agent does those itself, through ORYH's skills,
 * confirming in the conversation (ADR-0010). What stays is helping with a form that is on screen and
 * unsaved, so no prepare/confirm method or confirmation token reaches a tool.
 */
/** What the agent reads of the timesheet page: the form as synced, the document behind it and the options it may use. */
export interface TimesheetReadView {
  revision: number
  manager: boolean
  today: string
  options: TimesheetOptions
  ambiguousProjects: string[]
  records: TimesheetTodo[] | TimesheetHeader[]
  detail: TimesheetDetail | undefined
  form: TimesheetFields | undefined
  localEdits: string | undefined
  pendingSuggestion: TimesheetAction | undefined
  notice: string
}

/** The timesheets the agent may open for this person, and the person they belong to. */
export interface TimesheetCandidates {
  currentUser: OryhUser
  own: TimesheetHeader[]
  approvals: TimesheetTodo[]
  notice: string
}

export class TimesheetChat {
  /** The unsaved form as the agent last read or filled it, serialized as the page synced it. */
  private readonly seen = new Map<string, string>()
  constructor(
    private readonly ctx: Context,
    private readonly api: OryhTimesheetRemote | undefined,
    private readonly pane: PaneService,
    private readonly reviews: SubmitReview,
  ) {}

  /** The timesheet section of the pane, when a timesheet page is showing. */
  current(sessionId: string): TimesheetPaneContext | undefined {
    const session = this.pane.session(sessionId)
    return session?.page !== undefined && TIMESHEET_PAGES.includes(session.page)
      ? session.context?.timesheet
      : undefined
  }

  /**
   * The timesheet page on screen, with the identity verified now.
   * @param sessionId - session asking.
   * @param write - also require the page's write permission.
   */
  private async page(sessionId: string, write = false): Promise<TimesheetPage> {
    const captured = this.pane.session(sessionId)
    if (!captured?.page || !TIMESHEET_PAGES.includes(captured.page)) throw fail('请打开工时菜单并等待 Chat 已关联。')
    const manager = captured.page === 'timesheet-approvals'
    const { connection, session } = await this.pane.verified(sessionId)
    requirePage(connection.identity, captured.page)
    if (write) requirePermission(connection.identity, manager ? 'approval.record' : 'timesheet.submit_own')
    if (session.page !== captured.page) throw fail('页面已改变，请重新读取。')
    return { session, page: captured.page, manager, form: session.context?.timesheet }
  }

  private requireApi(): OryhTimesheetRemote {
    if (!this.api) throw fail('工时能力不可用。')
    return this.api
  }

  /**
   * The unsaved form the agent may discard to open another timesheet, serialized as the page holds it.
   *
   * Only a form the agent has itself seen in full — read, or filled and confirmed applied — and that
   * the person has not changed since, with no line being edited: once the agent has written that
   * content to ORYH in Chat, the draft is a stale copy, while anything the person typed afterwards is
   * theirs and still protected.
   */
  discardableForm(sessionId: string): string | undefined {
    const form = this.current(sessionId)
    if (!form?.fields) return undefined
    const serialized = JSON.stringify(form.fields)
    let editing = false
    if (form.localEdits)
      try {
        editing = (JSON.parse(form.localEdits) as { editing?: unknown }).editing !== undefined
      } catch {
        editing = true
      }
    if (this.seen.get(sessionId) !== serialized || editing)
      throw fail(
        '中间栏的未保存表单在你上次读取或填写之后被用户改动过，或有明细正在编辑，不能替换。请告诉用户在页面保存或放弃后，再打开工时。',
      )
    return serialized
  }

  /** Ask the agent to check this timesheet against the enterprise norms before submitting (docs/22). */
  async reviewStart(sessionId: string, headerId: string): Promise<void> {
    await this.page(sessionId, true)
    this.reviews.start(sessionId, {
      objectType: TIMESHEET_OBJECT_TYPE,
      documentId: headerId,
      label: '工时单',
      read: '先用 oryh_timesheet_read 读取实际内容',
    })
  }

  async read(sessionId: string, headerId: string = ''): Promise<TimesheetReadView> {
    const { session, manager, form } = await this.page(sessionId)
    if (!form) throw fail('工时表单尚未同步，请等待 Chat 已关联后重试。')
    const api = this.requireApi()
    const [options, records] = await Promise.all([
      api.timesheetOptions(session.connectionId),
      manager ? api.timesheetQueue(session.connectionId) : api.timesheetList(session.connectionId),
    ])
    const target = headerId || form.headerId
    const todo = manager ? records.find(r => 'entity_id' in r && r.entity_id === target) : undefined
    if (target && !records.some(r => ('entity_id' in r ? r.entity_id : r.id) === target))
      throw fail('该工时不在当前员工的工时或审批队列中。')
    const detail = target ? await api.timesheetDetail(session.connectionId, target, todo?.id) : undefined
    this.pane.assertUnchanged(sessionId, session, '用户已修改表单或离开页面，请重新读取后再建议。')
    if (form.fields) this.seen.set(sessionId, JSON.stringify(form.fields))
    // Duplicate names cannot be resolved from a name alone, and the id/name pairing cannot catch a
    // wrong pick between two projects that share one. Naming them forces the ambiguity to the user.
    const counts = new Map<string, number>()
    for (const p of options.projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
    const ambiguousProjects = [...counts].filter(([, count]) => count > 1).map(([name]) => name)
    const pending = this.pane.queue.peek(sessionId, 'form')
    return {
      revision: session.revision,
      manager,
      today: new Date().toLocaleDateString('en-CA'),
      options,
      ambiguousProjects,
      records,
      detail,
      form: form.fields,
      localEdits: form.localEdits,
      pendingSuggestion:
        pending?.lane === 'form' && pending.payload.kind === 'timesheet' ? pending.payload.action : undefined,
      notice:
        'form 是中间栏上未保存的表单内容，不代表服务端已保存。' +
        (ambiguousProjects.length
          ? `注意：名称“${ambiguousProjects.join('”“')}”各自对应多个不同项目；只有当用户要的正是其中之一时才必须先反问是哪一个，其余项目名称唯一，不必反问。`
          : ''),
    }
  }

  /**
   * Fill the unsaved form on screen with what the agent proposes.
   *
   * A whole-form action (`create`, `update`) is applied by the page at once, and the receipt reports
   * what the page then holds. A line action is offered as a suggestion the person applies or ignores.
   */
  async fill(sessionId: string, revision: number, input: unknown, signal: AbortSignal): Promise<string> {
    const { session, page, manager, form } = await this.page(sessionId, true)
    if (!form) throw fail('工时表单尚未同步，请等待 Chat 已关联后重试。')
    if (session.revision !== revision) throw fail('表单版本已改变，请重新读取。')
    // Submitting and approving are the agent's own writes through skills (ADR-0010), not a form fill,
    // so a model still reaching for them here is told where they went instead of a schema error.
    const kind = input !== null && typeof input === 'object' ? (input as { kind?: unknown }).kind : undefined
    if (kind === 'submit' || kind === 'approve')
      throw fail('提交和审批不经过中间栏表单：请按 ORYH 的工时或审批 skill 在对话里完成，写入前在对话里确认一次。')
    const parsed = actionSchema.safeParse(input)
    if (!parsed.success)
      throw fail(`工时建议格式无效：${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const action: TimesheetAction = pageAction(parsed.data)
    if (manager) throw fail('工时审批页面没有可填写的表单。审批请按 ORYH 的审批 skill 在对话里完成。')
    const data = await this.read(sessionId, action.headerId)
    if (action.kind === 'create' || action.kind === 'update') {
      const daily = new Map<string, number>()
      for (const l of action.fields!.entries) {
        if (l.hours < 0 || l.hours > 24) throw fail('每天工时不能超过 24 小时，也不能为负数。')
        daily.set(l.work_date, (daily.get(l.work_date) ?? 0) + l.hours)
      }
      if ([...daily.values()].some(h => h > 24)) throw fail('每天合计不能超过 24 小时。')
    }
    const editing = ['update', 'add-line', 'edit-line', 'delete-line'].includes(action.kind)
    if (editing && (!data.detail?.canEdit || form.headerId !== action.headerId))
      throw fail('请先打开允许编辑的本人工时。')
    if (action.kind === 'update') {
      const ids = action.fields!.entries.flatMap(l => (l.id ? [l.id] : []))
      if (new Set(ids).size !== ids.length || ids.some(id => !data.detail!.entries.some(l => l.id === id)))
        throw fail('已有明细编号必须保留且不能重复；新明细不传编号。')
    }
    if (action.line) {
      const d = data.detail!
      const entries =
        action.kind === 'edit-line'
          ? d.entries.map(e => (e.id === action.entryId ? action.line! : e))
          : [...d.entries, action.line]
      validateTimesheet({ ...d.header, entries })
    }
    if (
      (action.kind === 'edit-line' || action.kind === 'delete-line') &&
      !data.detail?.entries.some(e => e.id === action.entryId)
    )
      throw fail('明细不属于这张工时单。')
    if (editing && !data.options.editableStates.includes(data.detail!.header.status))
      throw fail('当前单据不允许修改明细。')
    const asserted =
      parsed.data.kind === 'create' || parsed.data.kind === 'update'
        ? parsed.data.fields.entries
        : 'line' in parsed.data
          ? [parsed.data.line]
          : []
    for (const l of asserted) {
      if (
        (l.work_type || !['create', 'update'].includes(action.kind)) &&
        !data.options.workTypes.some(o => o.name === l.work_type)
      )
        throw fail('请选择企业已配置的工时类型。')
      const named = l.project_name.trim()
      if (!l.project_id) {
        if (named)
          throw fail(
            `明细声明了项目“${named}”却没有给出项目编号。要关联项目必须同时给出编号与名称；不关联项目时两者都留空。`,
          )
        continue
      }
      const project = data.options.projects.find(o => o.id === l.project_id)
      if (!project) throw fail('请选择当前可用项目，不要猜测编号。')
      // The name is a second, independent statement of the same choice. An id-only check cannot
      // tell a correctly-formed id from the one the user actually asked for; a mismatch here is
      // the resolution error itself, surfaced before it reaches the form.
      if (!named) throw fail(`请同时给出项目名称以核对编号：编号 ${l.project_id} 对应“${project.name}”。`)
      if (named !== project.name)
        throw fail(
          `项目编号与名称不一致：编号 ${l.project_id} 实际是“${project.name}”，建议里写的是“${named}”。请重新确认用户要求的是哪个项目，必要时先反问，不要自行选择。`,
        )
    }
    this.pane.assertUnchanged(sessionId, session, '用户已修改表单或离开页面，请重新读取后再建议。')
    const proposal = { kind: 'timesheet' as const, revision, action }
    if (action.kind !== 'create' && action.kind !== 'update') {
      // A line suggestion is applied by the person: it stays offered until they do, or ignore it.
      const command = this.pane.publish(sessionId, { lane: 'form', page, payload: proposal, timeoutMs: 10 * 60_000 })
      return JSON.stringify({
        message: '已发送到中间栏未保存的工时表单，尚未保存到服务端。',
        proposalId: command.id,
        projects: data.options.projects,
      })
    }
    const applied = await this.pane.issue<{ message: string; applied: ReturnType<typeof appliedSummary> | undefined }>(
      sessionId,
      { lane: 'form', page, payload: proposal, timeoutMs: 6_000 },
      id => ({
        invalid: () => (this.pane.session(sessionId)?.page !== page ? '页面已离开，填写已取消' : undefined),
        until: () => {
          if (!this.pane.acked(sessionId, id)) return undefined
          // A synced page need not carry a form at all, so there may be nothing to summarize.
          const now = this.pane.session(sessionId)?.context?.timesheet?.fields
          const matched =
            now !== undefined && same(pageFields.safeParse(now).data, pageFields.safeParse(action.fields).data)
          if (matched) this.seen.set(sessionId, JSON.stringify(now))
          // The summary comes from the page's own snapshot either way, so a mismatch reports what
          // the form actually holds instead of what was requested.
          return {
            message: matched
              ? '中间栏工时表单已更新，尚未保存到服务端。以下 applied 是页面实际内容，请按它向用户复述，不要复述本次参数。'
              : '表单发生其他修改，请重新读取，不能声称填写成功。以下 applied 是页面实际内容。',
            applied: now === undefined ? undefined : appliedSummary(now, data.options.projects),
          }
        },
        expired: '表单未确认填写，请重新读取。',
        signal,
      }),
    )
    return JSON.stringify(applied)
  }

  /** Candidates the agent may open: the person's own timesheets and their approval queue. */
  async findTimesheets(sessionId: string): Promise<TimesheetCandidates> {
    const api = this.requireApi()
    const { connection, session } = await this.pane.verified(sessionId)
    const [own, approvals] = await Promise.all([
      api.timesheetList(session.connectionId),
      api.timesheetQueue(session.connectionId),
    ])
    if (this.pane.session(sessionId)?.scope !== session.scope) throw fail('企业页面已改变。')
    return {
      currentUser: connection.identity.user,
      own,
      approvals,
      notice:
        '仅返回本人单据和分配给自己的审批。按姓名、期间或编号匹配；候选不唯一先询问。审批候选以 entity_id 为 headerId、id 为 todoId。没有候选不能猜测编号。',
    }
  }

  /**
   * Open a timesheet in the business pane, or its blank create form.
   * @param discardDraft - replace the page's unsaved form, when the agent has already written its
   *   content in Chat; only a form the agent last saw unchanged is replaced (`discardableForm`).
   */
  async openTimesheet(
    sessionId: string,
    signal: AbortSignal,
    headerId: string = '',
    todoId: string = '',
    discardDraft: boolean = false,
  ): Promise<string> {
    const { connection, session } = await this.pane.verified(sessionId)
    const page: PageId = todoId ? 'timesheet-approvals' : 'timesheets'
    requirePage(connection.identity, page)
    if (!headerId && !todoId) requirePermission(connection.identity, 'timesheet.submit_own')
    if (headerId) await this.requireApi().timesheetDetail(session.connectionId, headerId, todoId || undefined)
    if (this.pane.session(sessionId)?.scope !== session.scope) throw fail('企业页面已改变。')
    // The page compares its form with this snapshot again when the command lands, so an edit made in between still wins.
    const discardForm = discardDraft && headerId ? this.discardableForm(sessionId) : undefined
    const manager = Boolean(todoId)
    return this.pane.issue<string>(
      sessionId,
      {
        lane: 'navigation',
        page,
        payload: {
          target: 'timesheet',
          page,
          ...(headerId ? { headerId, todoId, manager } : {}),
          ...(discardForm ? { discardForm } : {}),
        },
        timeoutMs: 15_000,
      },
      id => ({
        invalid: () => (this.pane.session(sessionId)?.scope !== session.scope ? '会话页面已离开。' : undefined),
        until: () => {
          if (!this.pane.acked(sessionId, id)) return undefined
          const state = this.current(sessionId)
          if (!state) return undefined
          if (headerId)
            return state.headerId === headerId && Boolean(state.manager) === manager
              ? `指定工时已在中间栏打开${discardForm ? '，原先的未保存表单已放弃' : ''}。编辑权限由服务端身份、权限和状态共同决定，请读取当前单据后继续；未修改或保存数据。`
              : undefined
          return state.fields
            ? '工时填写表单已打开，保留已有未保存内容。请调用 oryh_timesheet_read 获取版本和字段后填写；未保存到服务端。'
            : undefined
        },
        expired:
          headerId && !discardForm && this.current(sessionId)?.fields
            ? '工时未能打开，可能是中间栏的工时表单有未保存内容。如果这些内容已经由你在对话里写入服务端，读取表单确认后传 discardDraft=true 重试；否则请用户在页面保存或放弃后再打开。'
            : '表单未能打开，请检查连接或未保存的明细编辑，完成后重试。',
        signal,
      }),
    )
  }

  /** Forget what the agent saw of a session's form. */
  forget(sessionId: string): void {
    this.seen.delete(sessionId)
  }

  install(): void {
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_timesheet_read',
        description:
          '读取当前工时菜单的表单版本、未保存表单、本人工时或经理审批队列、企业工时类型和项目。headerId 为空读取当前页面；非空只可查询返回列表中的工时。',
        parameters: { headerId: { type: 'string', description: '工时编号；没有指定则传空字符串' } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw fail('需要会话')
          exec.signal.throwIfAborted()
          this.reviews.claimed(String(exec.agent.id))
          const result = await this.read(String(exec.agent.id), args.headerId)
          exec.signal.throwIfAborted()
          return JSON.stringify(result)
        },
      }),
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_timesheet_propose',
        description:
          '帮用户填写中间栏上正在编辑、尚未保存的工时表单；只改这张表单，不写服务端。新建、修改、提交或审批工时请按工时 skill 在对话里直接完成，不用这个工具。先 read 获取 revision，传 action 对象。新建表单：kind=create；编辑已打开的工时：kind=update,headerId，fields 中已有行保留 id，新增行不传 id，删除行从 entries 移除。优先更新整张表单，由用户在页面统一保存。fields 为完整快照，保留未要求修改的内容。允许分步填写：未知字段保留空字符串，未填写小时保留 0，不必等所有内容齐全；页面保存时会校验完整性。添加明细：kind=add-line,headerId,line。编辑：kind=edit-line,headerId,entryId,line。删除明细：kind=delete-line,headerId,entryId。只传该操作需要的字段。关联项目必须同时给出 project_id 与 project_name，名称逐字取自 read 的 projects；两者不一致会被拒绝，这是为了拦住编号解析错误。不关联项目时 project_id 与 project_name 都传空字符串。read 的 ambiguousProjects 列出同名项目，遇到时必须先反问用户是哪一个，不要自行挑选。日期为 YYYY-MM-DD，工时类型必须使用 read 返回的 name。create 和 update 自动更新中间栏的未保存表单，无需点击应用。成功回执里的 applied 是页面实际生效的内容（项目编号与名称、每日工时、合计），向用户复述必须依据它，不能复述本次调用的参数；表单尚未保存到服务端。',
        parameters: { revision: { type: 'integer', required: true }, action: actionSpec },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw fail('需要会话')
          exec.signal.throwIfAborted()
          return this.fill(String(exec.agent.id), args.revision, args.action, exec.signal)
        },
      }),
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_find_timesheets',
        description:
          '从任意页面查询可打开的本人工时及本人审批队列，按姓名、期间和编号选择。候选不唯一必须询问，不跨越权限边界。',
        parameters: {},
        output: textOutput,
        execute: async (_args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          exec.signal.throwIfAborted()
          return JSON.stringify(await this.findTimesheets(String(exec.agent.id)))
        },
      }),
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_open_timesheet',
        description:
          '在中间栏打开指定工时单，自动按权限和状态显示编辑或详情；编号为空时打开新建表单。先查询候选，不猜编号，不覆盖用户的未保存修改。',
        parameters: {
          headerId: { type: 'string', description: '已查询到的工时编号；新建时传空字符串' },
          todoId: {
            type: 'string',
            description: '打开他人工时必须传查询到的本人审批待办编号；本人工时或新建传空字符串',
          },
          discardDraft: {
            type: 'boolean',
            description:
              '中间栏未保存表单的内容已经由你在对话里写入服务端时传 true，放弃这份草稿再打开 headerId。只有表单自你上次读取或填写后未被用户改动才会放弃，否则仍拒绝。其他情况传 false',
          },
        },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.openTimesheet(
            String(exec.agent.id),
            exec.signal,
            args.headerId,
            args.todoId,
            args.discardDraft === true,
          )
        },
      }),
    )
    this.ctx.effect(() => () => this.seen.clear(), 'oryh timesheet suggestions')
  }
}
