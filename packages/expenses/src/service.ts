import { createHash, randomUUID } from 'node:crypto'
import {
  type ConnectionId,
  connectionId,
  employeeScope,
  OryhClientError,
  type OryhOperation,
  pageOperation,
} from '@oryh/ai-client-foundation'
import { requirePermission } from '@oryh/ai-client-pages'
import {
  EXPENSE_OBJECT_TYPE,
  type ExpenseDraft,
  type ExpenseFields,
  expenseError,
  type OryhExpenseRemote,
  object,
  parseExpenseFields,
} from './contracts.js'
import type { ExpenseRecord, ExpenseStore } from './store.js'

/** The transport this service needs. Expenses write, so the request shape is the full one. */
export interface ExpenseHttp {
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
export interface ExpenseConnection {
  readonly origin: string
  readonly identity: {
    readonly permissions?: readonly string[]
    readonly user: { readonly id: string; readonly employeeId: string | null }
    readonly tenant: { readonly id: string }
  }
}

/** Deterministic expense workflow. Writes consume a version-bound, expiring confirmation. */
export class ExpenseService implements OryhExpenseRemote {
  private readonly uploads = new Map<string, { id: string; filename: string; sha256: string }>()
  constructor(
    private readonly store: ExpenseStore,
    private readonly http: ExpenseHttp,
    private readonly connection: (id: string) => ExpenseConnection,
    private readonly verify: (id: string) => Promise<ExpenseConnection>,
  ) {}

  private scope(id: string): string {
    const connection = this.connection(id)
    if (connection.identity.user.employeeId === null) throw expenseError('当前账号未关联员工，不能填写费用申请。')
    return employeeScope(connection)
  }
  private guard(id: string, scope: string): void {
    if (this.scope(id) !== scope) throw expenseError('企业或身份已改变，请重新打开草稿。')
  }
  private async read(id: string, draftId: string, revision: number): Promise<ExpenseRecord> {
    const scope = this.scope(id)
    const record = (await this.store.list()).find(row => row.id === draftId && row.scope === scope)
    this.guard(id, scope)
    if (record === undefined || record.archived || record.revision !== revision)
      throw expenseError('草稿已改变或不可用，请刷新。')
    return record
  }
  private async next(id: string, record: ExpenseRecord, changes: Partial<ExpenseRecord>): Promise<ExpenseRecord> {
    this.guard(id, record.scope)
    const next = { ...record, ...changes, revision: record.revision + 1, updatedAt: new Date().toISOString() }
    await this.store.append(next, record.revision)
    this.guard(id, record.scope)
    return next
  }
  private view(record: ExpenseRecord): ExpenseDraft {
    const { scope: _scope, serverDigest: _digest, archived: _archived, ...view } = record
    if (view.state === 'creating')
      return { ...view, state: 'unknown-create', message: '创建结果尚未确认。请核对，不要重复创建。' }
    if (view.state === 'submitting')
      return { ...view, state: 'unknown-submit', message: '提交结果尚未确认。请核对服务端状态。' }
    return view
  }
  async expenseList(id: string): Promise<ExpenseDraft[]> {
    // Await verification first: a concurrent re-verification revokes the registry entry until
    // `/auth/me` returns, and a bare `scope()` would throw inside that window.
    await this.verify(id)
    const scope = this.scope(id)
    const records = await this.store.list()
    this.guard(id, scope)
    return records
      .filter(row => row.scope === scope && !row.archived)
      .map(row => this.view(row))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async expenseOptions(id: string) {
    await this.verify(id)
    const scope = this.scope(id)
    const body = object(
      await this.http.request(connectionId(id), { path: '/type-options?family=expense_category&status=active' }),
    )
    this.guard(id, scope)
    if (!Array.isArray(body.data)) throw expenseError('费用类别响应无效。')
    return {
      categories: body.data.map(value => {
        const row = object(value)
        if (typeof row.name !== 'string') throw expenseError('费用类别响应无效。')
        return { name: row.name, title: typeof row.title === 'string' ? row.title : row.name }
      }),
    }
  }
  async expenseSave(
    id: string,
    input: { id?: string; revision?: number; fields: ExpenseFields },
  ): Promise<ExpenseDraft> {
    const fields = parseExpenseFields(input.fields, false)
    await this.verify(id)
    const scope = this.scope(id)
    const previous = (await this.store.list()).filter(row => row.scope === scope)
    for (const line of fields.items) {
      if (line.attachment === undefined) continue
      const receipt =
        this.uploads.get(`${scope}:${line.attachment.id}`) ??
        previous.flatMap(row => row.fields.items).find(row => row.attachment?.id === line.attachment!.id)?.attachment
      if (
        receipt === undefined ||
        receipt.sha256 !== line.attachment.sha256 ||
        receipt.filename !== line.attachment.filename
      )
        throw expenseError('票据必须从当前企业的上传入口选择。')
    }
    if (input.id !== undefined) {
      const current = await this.read(id, input.id, input.revision ?? -1)
      if (!['editing', 'review-create'].includes(current.state))
        throw expenseError('服务端已开始创建，不能覆盖本地草稿。')
      return this.view(
        await this.next(id, current, { fields, state: 'editing', confirmation: undefined, message: undefined }),
      )
    }
    const record: ExpenseRecord = {
      id: randomUUID(),
      revision: 1,
      scope,
      fields,
      state: 'editing',
      updatedAt: new Date().toISOString(),
    }
    this.guard(id, scope)
    await this.store.append(record, 0)
    this.guard(id, scope)
    return this.view(record)
  }
  private payload(record: ExpenseRecord, id: string) {
    return {
      employee_id: this.connection(id).identity.user.employeeId,
      title: record.fields.title,
      claim_date: record.fields.claimDate,
      currency: record.fields.currency,
      custom_fields: { oryh_client_draft_id: record.id },
      items: record.fields.items.map(line => ({
        expense_date: line.expenseDate,
        category: line.category,
        amount: Number(line.amount),
        merchant: line.merchant || null,
        invoice_number: line.invoiceNumber || null,
        notes: line.notes || null,
        ...(line.attachment === undefined ? {} : { attachment_id: line.attachment.id }),
      })),
    }
  }
  private async detail(id: string, record: ExpenseRecord): Promise<Record<string, unknown>> {
    if (record.claimId === undefined) throw expenseError('尚未取得服务端申请编号。')
    const body = object(
      await this.http.request(connectionId(id), {
        path: `/expense-claims/${encodeURIComponent(record.claimId)}/detail`,
      }),
    )
    this.guard(id, record.scope)
    const detail = object(body.data)
    const claim = object(detail.claim)
    if (
      claim.id !== record.claimId ||
      claim.employee_id !== this.connection(id).identity.user.employeeId ||
      object(claim.custom_fields).oryh_client_draft_id !== record.id
    )
      throw expenseError('服务端费用申请与当前草稿不匹配。')
    return detail
  }
  async expensePrepare(id: string, draftId: string, revision: number): Promise<ExpenseDraft> {
    requirePermission((await this.verify(id)).identity, 'expense.submit_own')
    let record = await this.read(id, draftId, revision)
    let action: 'create' | 'submit'
    let serverDigest: string | undefined
    if (record.state === 'editing' || record.state === 'review-create') {
      action = 'create'
      parseExpenseFields(record.fields)
      const body = object(
        await this.http.request(connectionId(id), {
          path: '/expense-claims?validate_only=true',
          method: 'POST',
          body: this.payload(record, id),
          retryExpired: false,
        }),
      )
      const meta = object(body.meta)
      if (meta.validate_only !== true || meta.written !== false)
        throw expenseError('服务端没有确认仅校验模式，已停止创建。')
    } else if (record.state === 'created' || record.state === 'review-submit') {
      action = 'submit'
      const detail = await this.detail(id, record)
      if (!matchesFields(detail, record.fields))
        throw expenseError('服务端内容已改变，请到 ORYH 核对和处理，不能沿用本地确认。')
      const claim = object(detail.claim)
      if (claim.submitted_at != null)
        return this.view(
          await this.next(id, record, {
            state: 'submitted',
            serverStatus: String(claim.status),
            submittedAt: String(claim.submitted_at),
            confirmation: undefined,
          }),
        )
      serverDigest = digest(detail)
    } else throw expenseError('请先保存草稿或核对执行结果。')
    record = await this.next(id, record, {
      state: action === 'create' ? 'review-create' : 'review-submit',
      serverDigest,
      confirmation: { token: randomUUID(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), action },
      message: undefined,
    })
    return this.view(record)
  }
  /**
   * Refuse a submit the pre-submit norm review has not cleared.
   *
   * `expense_claim` carries a workflow definition, so its submit needs the same gate the timesheet
   * has (docs/22). The verdict lives in the Host's chat layer, which this package must not depend
   * on, so the Host installs the check here — in the service rather than the page, because a
   * disabled button is a suggestion and the Remote is reachable without it.
   * @param gate - throws when the submit may not be confirmed.
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
  async expenseConfirm(
    id: string,
    draftId: string,
    revision: number,
    token: string,
    sessionId?: string,
  ): Promise<ExpenseDraft> {
    requirePermission((await this.verify(id)).identity, 'expense.submit_own')
    let record = await this.read(id, draftId, revision)
    const confirmation = record.confirmation
    if (
      confirmation === undefined ||
      confirmation.token !== token ||
      Date.parse(confirmation.expiresAt) <= Date.now() ||
      (record.state !== 'review-create' && record.state !== 'review-submit')
    )
      throw expenseError('确认已失效，请重新校验和确认。')
    const action = confirmation.action
    if (action === 'submit') {
      if (await (this.governs?.(id, EXPENSE_OBJECT_TYPE) ?? Promise.resolve(false)))
        this.gate?.(EXPENSE_OBJECT_TYPE, draftId, sessionId)
      const detail = await this.detail(id, record)
      if (record.serverDigest !== digest(detail)) {
        await this.next(id, record, {
          state: 'created',
          confirmation: undefined,
          message: '服务端内容已改变，请重新核对。',
        })
        throw expenseError('服务端内容已改变，原确认已失效。')
      }
    }
    // Durable intent precedes network I/O. A competing revision cannot issue the same write.
    record = await this.next(id, record, {
      state: action === 'create' ? 'creating' : 'submitting',
      confirmation: undefined,
    })
    try {
      this.guard(id, record.scope)
      const write = {
        path:
          action === 'create'
            ? ('/expense-claims' as const)
            : (`/expense-claims/${encodeURIComponent(record.claimId!)}/submit` as const),
        method: 'POST' as const,
        body: action === 'create' ? this.payload(record, id) : {},
      }
      // One draft creates and then submits; the action and revision make each write its own operation.
      const body = object(
        await this.http.request(connectionId(id), {
          ...write,
          retryExpired: false,
          operation: pageOperation(`${record.id}:${action}:${record.revision}`, write, hashText),
        }),
      )
      const claim = object(body.data)
      if (
        typeof claim.id !== 'string' ||
        typeof claim.status !== 'string' ||
        claim.employee_id !== this.connection(id).identity.user.employeeId ||
        (action === 'submit' && (claim.id !== record.claimId || typeof claim.submitted_at !== 'string'))
      )
        throw expenseError('服务端回执不完整，请核对结果。')
      return this.view(
        await this.next(id, record, {
          state: action === 'create' ? 'created' : 'submitted',
          claimId: claim.id,
          serverStatus: String(claim.status),
          submittedAt: typeof claim.submitted_at === 'string' ? claim.submitted_at : null,
          message: undefined,
        }),
      )
    } catch (error) {
      const rejected =
        error instanceof OryhClientError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.code === 'request-failed'
      const message = rejected
        ? `ORYH 拒绝本次操作（${error.status}）。请检查权限和字段后重新校验。`
        : '结果未知。请核对已有记录；客户端不会自动重放本次写入。'
      return this.view(
        await this.next(id, record, {
          state: rejected
            ? action === 'create'
              ? 'editing'
              : 'created'
            : action === 'create'
              ? 'unknown-create'
              : 'unknown-submit',
          message,
        }),
      )
    }
  }
  async expenseReconcile(id: string, draftId: string, revision: number): Promise<ExpenseDraft> {
    requirePermission((await this.verify(id)).identity, 'expense.submit_own')
    let record = await this.read(id, draftId, revision)
    if (record.claimId === undefined) {
      const matches: Record<string, unknown>[] = []
      let complete = false
      for (let page = 1; page <= 20; page += 1) {
        const employee = encodeURIComponent(this.connection(id).identity.user.employeeId!)
        const body = object(
          await this.http.request(connectionId(id), {
            path: `/expense-claims?employee_id=${employee}&page=${page}&size=100`,
          }),
        )
        this.guard(id, record.scope)
        if (!Array.isArray(body.data)) throw expenseError('核对响应无效。')
        for (const value of body.data) {
          const row = object(value)
          if (row.custom_fields != null && object(row.custom_fields).oryh_client_draft_id === record.id)
            matches.push(row)
        }
        const pages = object(body.meta).pages
        if (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 0)
          throw expenseError('核对列表缺少有效分页信息，不能判定结果唯一。')
        if (page >= pages) {
          complete = true
          break
        }
      }
      if (!complete || matches.length !== 1 || typeof matches[0]!.id !== 'string')
        throw expenseError('未能唯一定位创建结果。请在 ORYH 核对，不能据此认定创建失败或再次创建。')
      record = { ...record, claimId: matches[0]!.id }
    }
    const detail = await this.detail(id, record)
    if (!matchesFields(detail, record.fields)) throw expenseError('服务端内容与草稿不同，请在 ORYH 核对。')
    const claim = object(detail.claim)
    return this.view(
      await this.next(id, record, {
        state: claim.submitted_at == null ? 'created' : 'submitted',
        serverStatus: String(claim.status),
        submittedAt: claim.submitted_at == null ? null : String(claim.submitted_at),
        confirmation: undefined,
        message: '已从 ORYH 重新读取并核对记录。',
      }),
    )
  }
  async expenseUpload(id: string, input: { filename: string; contentType: string; contentBase64: string }) {
    await this.verify(id)
    const scope = this.scope(id)
    if (
      typeof input.filename !== 'string' ||
      input.filename.length === 0 ||
      input.filename.length > 255 ||
      !['application/pdf', 'image/png', 'image/jpeg'].includes(input.contentType) ||
      typeof input.contentBase64 !== 'string' ||
      input.contentBase64.length > 700_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.contentBase64)
    )
      throw expenseError('附件仅支持 500 KB 内的 PDF、PNG 或 JPEG。')
    const bytes = Buffer.from(input.contentBase64, 'base64')
    if (bytes.length === 0 || bytes.length > 500 * 1024) throw expenseError('附件超过 500 KB 限制。')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const upload = {
      path: '/attachments' as const,
      method: 'POST' as const,
      body: { filename: input.filename, content_type: input.contentType, content_base64: input.contentBase64 },
    }
    // Choosing the file is the person's confirmation of this upload.
    const body = object(
      await this.http.request(connectionId(id), {
        ...upload,
        retryExpired: false,
        operation: pageOperation(randomUUID(), upload, hashText),
      }),
    )
    this.guard(id, scope)
    const attachment = object(body.data)
    if (typeof attachment.id !== 'string' || attachment.sha256 !== sha256) throw expenseError('附件上传回执无法核对。')
    const receipt = { id: attachment.id, filename: String(attachment.filename), sha256 }
    this.uploads.set(`${scope}:${receipt.id}`, receipt)
    return receipt
  }
  async expenseDelete(id: string, draftId: string, revision: number): Promise<void> {
    await this.verify(id)
    const record = await this.read(id, draftId, revision)
    if (!['editing', 'review-create', 'submitted'].includes(record.state))
      throw expenseError('未决申请必须先核对结果，不能归档。')
    await this.next(id, record, { archived: true, confirmation: undefined })
  }
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function matchesFields(detail: Record<string, unknown>, fields: ExpenseFields): boolean {
  const claim = object(detail.claim)
  if (
    claim.title !== fields.title ||
    claim.claim_date !== fields.claimDate ||
    claim.currency !== fields.currency ||
    !Array.isArray(detail.items) ||
    detail.items.length !== fields.items.length
  )
    return false
  const actual = detail.items
    .map(value => {
      const row = object(value)
      return JSON.stringify([
        row.expense_date,
        row.category,
        Number(row.amount).toFixed(2),
        row.merchant ?? '',
        row.invoice_number ?? '',
        row.notes ?? '',
        row.attachment_id ?? null,
      ])
    })
    .sort()
  const expected = fields.items
    .map(row =>
      JSON.stringify([
        row.expenseDate,
        row.category,
        row.amount,
        row.merchant,
        row.invoiceNumber,
        row.notes,
        row.attachment?.id ?? null,
      ]),
    )
    .sort()
  return actual.every((row, index) => row === expected[index])
}

const hashText = (text: string) => createHash('sha256').update(text).digest('hex')
