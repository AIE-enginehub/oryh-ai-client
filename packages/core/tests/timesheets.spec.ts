import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EncryptedTimesheetStore,
  MemoryTimesheetStore,
  type TimesheetFields,
  TimesheetService,
  validateTimesheet,
} from '@oryh/ai-client-timesheets'
import { describe, expect, it } from 'vitest'
import { ConnectionRegistry, MemoryCredentialVault, OryhHttpClient } from '../src/index.js'
import { jsonResponse } from './fixtures.js'

const fields: TimesheetFields = {
  period_start: '2026-09-07',
  period_end: '2026-09-11',
  source_report_text: '原始工时',
  entries: [
    { work_date: '2026-09-08', hours: 7.25, work_type: 'regular', project_id: '', task: '测试任务', notes: '真实记录' },
  ],
}
function setup() {
  const registry = new ConnectionRegistry(),
    vault = new MemoryCredentialVault(),
    store = new MemoryTimesheetStore()
  const c = registry.add({
    origin: 'https://oryh.example',
    identity: {
      permissions: [
        'master_data.manage',
        'expense.submit_own',
        'timesheet.submit_own',
        'approval.record',
        'order.submit_own',
        'inventory.manage',
      ],
      user: { id: 'user', email: 'test@example.invalid', name: 'Test', employeeId: 'employee', role: 'member' },
      tenant: { id: 'tenant', slug: 'tenant', name: 'Tenant', environmentId: null },
    },
  })
  registry.markVerified(c.id, c.identity)
  const headers: Record<string, any>[] = [
    {
      id: 'h',
      employee_id: 'employee',
      period_start: fields.period_start,
      period_end: fields.period_end,
      status: 'draft',
      source_report_text: 'original',
      custom_fields: {},
    },
  ]
  let entries: Record<string, any>[] = [{ ...fields.entries[0], id: 'entry', header_id: 'h', custom_fields: {} }]
  const history: Record<string, any>[] = [
    { id: 'submission', round_no: 1, sequence_no: 1, action: 'submitted', metadata: {} },
  ]
  const todos: Record<string, any>[] = [
    {
      id: 'todo',
      employee_id: 'employee',
      entity_type: 'timesheet_header',
      entity_id: 'h',
      todo_type: 'approval',
      status: 'open',
      title: '经理审批',
      metadata: { round_no: 1, sequence_no: 2 },
    },
  ]
  const calls: { path: string; method: string; body: Record<string, any> }[] = []
  let lose = false,
    reject = 0,
    dryRun = true,
    grants = ['timesheet.submit_own']
  const http = new OryhHttpClient(registry, vault, async (input, init) => {
    const u = new URL(input),
      path = u.pathname.replace('/api/v1', ''),
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path: u.pathname + u.search, method, body })
    if (u.searchParams.has('validate_only'))
      return jsonResponse(200, { data: { id: 'dry' }, meta: dryRun ? { validate_only: true, written: false } : {} })
    if (method === 'GET') {
      if (path === '/auth/me') return jsonResponse(200, { data: { permissions: grants } })
      if (path === '/todos')
        return jsonResponse(200, { data: todos.filter(t => t.status === 'open'), meta: { pages: 1 } })
      if (path === '/timesheet-headers') return jsonResponse(200, { data: headers, meta: { pages: 1 } })
      if (path.endsWith('/detail'))
        return jsonResponse(200, {
          data: { header: headers.find(h => path.includes('/' + h.id + '/')), entries, approval_records: history },
        })
      return jsonResponse(200, { data: [], meta: { pages: 1 } })
    }
    if (reject) return jsonResponse(reject, { detail: 'rejected' })
    let data: Record<string, any>
    if (path === '/timesheet-headers') {
      data = { ...body, id: 'created', status: 'draft' }
      headers.push(data)
    } else if (path === '/approval-records') {
      data = { ...body, id: 'decision', approver_id: 'user' }
      history.push(data)
      todos[0]!.status = 'completed'
    } else if (path.endsWith('/submit')) {
      data = headers[0]!
      data.status = 'waiting'
      history.push({ id: 'new-submission', action: 'submitted', round_no: 2, sequence_no: 1 })
    } else if (path === '/timesheet-entries') {
      data = { ...body, id: 'new-entry' }
      entries.push(data)
    } else if (method === 'DELETE') {
      entries = entries.filter(e => !path.endsWith('/' + e.id))
      if (lose) throw Error('response lost')
      return {
        ok: true,
        status: 204,
        json: async () => {
          throw Error('204 has no JSON')
        },
      }
    } else {
      data = entries.find(e => path.endsWith('/' + e.id))!
      Object.assign(data, body)
    }
    if (lose) throw Error('response lost after commit')
    return jsonResponse(200, { data })
  })
  const service = () =>
    new TimesheetService(
      store,
      http,
      id => registry.requireVerified(id as typeof c.id),
      async id => registry.requireVerified(id as typeof c.id),
    )
  return {
    s: service(),
    service,
    store,
    c,
    registry,
    headers,
    history,
    todos,
    calls,
    init: () => vault.write(c.id, { accessKey: 'synthetic', refreshToken: 'synthetic', expiresAt: null }),
    lose: () => {
      lose = true
    },
    reject: (code: number) => {
      reject = code
    },
    noDryRun: () => {
      dryRun = false
    },
    entries: () => entries,
    // What ORYH grants, as a verification would find it: `/auth/me` answers it, and the verified
    // identity in the registry carries it, which is what the service reads.
    grants: (value: string[]) => {
      grants = value
      registry.markVerified(c.id, { ...registry.requireVerified(c.id).identity, permissions: value })
    },
  }
}
async function fixture() {
  const f = setup()
  await f.init()
  return f
}
describe('timesheet business operations', () => {
  it('validates real dates, per-day totals, period and work types without changing hours', () => {
    expect(() => validateTimesheet(fields)).not.toThrow()
    expect(fields.entries[0]!.hours).toBe(7.25)
    for (const patch of [
      { period_start: '2026-02-30' },
      { entries: [{ ...fields.entries[0]!, hours: 0 }] },
      { entries: [{ ...fields.entries[0]!, work_date: '2026-09-12' }] },
      {
        entries: [
          { ...fields.entries[0]!, hours: 13 },
          { ...fields.entries[0]!, hours: 12 },
        ],
      },
      { entries: [{ ...fields.entries[0]!, work_type: '' }] },
    ])
      expect(() => validateTimesheet({ ...fields, ...patch })).toThrow()
  })
  it('creates all entries atomically with host-owned identity and a one-use confirmation', async () => {
    const f = await fixture(),
      r = await f.s.timesheetPrepare(f.c.id, { kind: 'create', fields })
    expect(f.headers).toHaveLength(1)
    expect(f.calls[0]!.body.employee_id).toBe('employee')
    const result = await f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)
    expect(result.state).toBe('done')
    expect(f.headers[1]!.entries).toHaveLength(1)
    await expect(f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)).rejects.toThrow()
    expect(f.calls.filter(c => c.path === '/api/v1/timesheet-headers')).toHaveLength(1)
  })
  it('refuses a missing dry-run guarantee and expired confirmation', async () => {
    const f = await fixture()
    f.noDryRun()
    await expect(f.s.timesheetPrepare(f.c.id, { kind: 'create', fields })).rejects.toThrow()
    const g = await fixture(),
      r = await g.s.timesheetPrepare(g.c.id, { kind: 'create', fields })
    const saved = (await g.store.list())[0]!
    await g.store.append({ ...saved, revision: 2, expiresAt: 0 }, 1)
    await expect(g.s.timesheetConfirm(g.c.id, r.id, 2, r.token)).rejects.toThrow(/过期/)
  })
  it('recovers a lost create receipt after restarting without resending', async () => {
    const f = await fixture(),
      r = await f.s.timesheetPrepare(f.c.id, { kind: 'create', fields })
    f.lose()
    const uncertain = await f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)
    expect(uncertain.state).toBe('unknown')
    const restarted = f.service()
    await expect(restarted.timesheetPrepare(f.c.id, { kind: 'create', fields })).rejects.toThrow(/核对/)
    const reconciled = await restarted.timesheetReconcile(f.c.id, r.id, uncertain.revision)
    expect(reconciled.state).toBe('done')
    expect(reconciled.resultId).toBe('created')
    expect(f.calls.filter(c => c.path === '/api/v1/timesheet-headers')).toHaveLength(1)
  })
  it('checks ownership for detail and refuses self or unassigned approvals', async () => {
    const f = await fixture()
    await expect(f.s.timesheetDetail(f.c.id, 'h', 'todo')).rejects.toThrow(/自己/)
    f.headers[0]!.employee_id = 'other'
    await expect(f.s.timesheetDetail(f.c.id, 'h')).rejects.toThrow(/不属于/)
    await expect(
      f.s.timesheetPrepare(f.c.id, { kind: 'approve', headerId: 'h', decision: 'approved', comment: '同意' }),
    ).rejects.toThrow()
    f.todos[0]!.employee_id = 'another'
    await expect(f.s.timesheetDetail(f.c.id, 'h', 'todo')).rejects.toThrow(/未分配/)
  })
  it('records manager decision at assigned node, never patches status or closes todo separately', async () => {
    const f = await fixture()
    f.headers[0]!.employee_id = 'other'
    f.headers[0]!.status = 'waiting'
    const r = await f.s.timesheetPrepare(f.c.id, {
      kind: 'approve',
      headerId: 'h',
      todoId: 'todo',
      decision: 'returned',
      comment: '补充项目说明',
    })
    const n = await f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)
    expect(n.state).toBe('done')
    const writes = f.calls.filter(c => c.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.body).toMatchObject({ round_no: 1, sequence_no: 2, action: 'returned', source: 'web' })
    expect(writes[0]!.body).not.toHaveProperty('document_status')
    expect(writes[0]!.body).not.toHaveProperty('approver_id')
    expect(f.headers[0]!.status).toBe('waiting')
  })
  it('rejects stale detail, expired node and tenant identity changes before writes', async () => {
    const f = await fixture()
    f.headers[0]!.employee_id = 'other'
    const a = {
      kind: 'approve' as const,
      headerId: 'h',
      todoId: 'todo',
      decision: 'approved' as const,
      comment: '核对一致',
    }
    const r = await f.s.timesheetPrepare(f.c.id, a)
    f.entries()[0]!.hours = 8
    await expect(f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)).rejects.toThrow(/改变/)
    f.todos[0]!.metadata.round_no = 2
    await expect(f.s.timesheetPrepare(f.c.id, a)).rejects.toThrow(/轮次/)
    f.registry.markVerified(f.c.id, { ...f.c.identity, user: { ...f.c.identity.user, employeeId: 'replacement' } })
    await expect(f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)).rejects.toThrow()
    expect(f.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('reconciles approval after own todo is closed and allocates missing sequence above submission', async () => {
    const f = await fixture()
    f.headers[0]!.employee_id = 'other'
    delete f.todos[0]!.metadata.sequence_no
    const r = await f.s.timesheetPrepare(f.c.id, {
      kind: 'approve',
      headerId: 'h',
      todoId: 'todo',
      decision: 'approved',
      comment: '已核对',
    })
    f.lose()
    const n = await f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)
    expect(n.state).toBe('unknown')
    expect(f.history.at(-1)!.sequence_no).toBe(2)
    expect((await f.service().timesheetReconcile(f.c.id, n.id, n.revision)).state).toBe('done')
  })
  it('serializes competing confirmations so a line is only added once', async () => {
    const f = await fixture(),
      action = { kind: 'add-line' as const, headerId: 'h', line: { ...fields.entries[0]!, hours: 1 } }
    const [a, b] = await Promise.all([f.s.timesheetPrepare(f.c.id, action), f.s.timesheetPrepare(f.c.id, action)])
    const results = await Promise.allSettled([
      f.s.timesheetConfirm(f.c.id, a.id, a.revision, a.token),
      f.s.timesheetConfirm(f.c.id, b.id, b.revision, b.token),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(f.entries()).toHaveLength(2)
    expect(f.calls.find(c => c.path === '/api/v1/timesheet-entries')!.body.employee_id).toBe('employee')
  })
  it('handles successful 204 deletion and rejected writes without automatic replay', async () => {
    const f = await fixture(),
      r = await f.s.timesheetPrepare(f.c.id, { kind: 'delete-line', headerId: 'h', entryId: 'entry' })
    expect((await f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)).state).toBe('done')
    expect(f.entries()).toHaveLength(0)
    const g = await fixture(),
      a = await g.s.timesheetPrepare(g.c.id, { kind: 'create', fields })
    g.reject(422)
    expect((await g.s.timesheetConfirm(g.c.id, a.id, a.revision, a.token)).state).toBe('failed')
    expect(g.headers).toHaveLength(1)
  })
  it('does not edit a saved date, and rechecks all lines before submission', async () => {
    const f = await fixture()
    await expect(
      f.s.timesheetPrepare(f.c.id, {
        kind: 'edit-line',
        headerId: 'h',
        entryId: 'entry',
        line: { ...fields.entries[0]!, work_date: '2026-09-09' },
      }),
    ).rejects.toThrow(/日期/)
    const r = await f.s.timesheetPrepare(f.c.id, { kind: 'submit', headerId: 'h' })
    f.entries()[0]!.task = 'updated'
    await expect(f.s.timesheetConfirm(f.c.id, r.id, r.revision, r.token)).rejects.toThrow(/改变/)
  })
  it('persists encrypted journal revisions and rejects stale writers', async () => {
    const f = await fixture()
    await f.s.timesheetPrepare(f.c.id, { kind: 'create', fields })
    const record = (await f.store.list())[0]!
    const directory = await mkdtemp(join(tmpdir(), 'oryh-timesheet-'))
    try {
      const key = Buffer.alloc(32, 7),
        store = new EncryptedTimesheetStore(directory, async () => key)
      await store.append(record, 0)
      const bytes = await readFile(join(directory, (await readdir(directory))[0]!))
      expect(bytes.includes(Buffer.from(fields.source_report_text))).toBe(false)
      expect(await store.list()).toEqual([record])
      await expect(store.append(record, 0)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('tenant workflow rules', () => {
  it('uses the tenant definition for editable and submittable states', async () => {
    const registry = new ConnectionRegistry(),
      vault = new MemoryCredentialVault()
    const c = registry.add({
      origin: 'https://oryh.example',
      identity: {
        permissions: [
          'master_data.manage',
          'expense.submit_own',
          'timesheet.submit_own',
          'approval.record',
          'order.submit_own',
          'inventory.manage',
        ],
        user: { id: 'u', email: 'u@example.invalid', name: 'u', employeeId: 'e', role: 'member' },
        tenant: { id: 't', slug: 't', name: 't', environmentId: null },
      },
    })
    registry.markVerified(c.id, c.identity)
    await vault.write(c.id, { accessKey: 'synthetic', refreshToken: 'synthetic', expiresAt: null })
    const http = new OryhHttpClient(registry, vault, async input =>
      jsonResponse(200, {
        data: new URL(input).pathname.endsWith('object-type-definitions')
          ? [
              {
                state_machine: {
                  states: ['editing', 'waiting', 'rework', 'final'],
                  roles: { submitted: 'waiting' },
                  editable_states: ['editing', 'rework'],
                  transitions: { editing: ['waiting'], rework: ['waiting'], waiting: ['final'] },
                },
              },
            ]
          : [],
      }),
    )
    const s = new TimesheetService(
      new MemoryTimesheetStore(),
      http,
      () => c,
      async () => c,
    )
    expect(await s.timesheetOptions(c.id)).toMatchObject({
      editableStates: ['editing', 'rework'],
      submitStates: ['editing', 'rework'],
    })
  })
})

describe('timesheet edit access', () => {
  it('requires ownership, a live editable state and explicit server permission', async () => {
    const f = await fixture()
    expect((await f.s.timesheetDetail(f.c.id, 'h')).canEdit).toBe(true)
    // May open the page (an approver), but may not submit their own: the form is read-only.
    f.grants(['approval.record'])
    expect((await f.s.timesheetDetail(f.c.id, 'h')).canEdit).toBe(false)
    // No timesheet grant at all: the page itself is refused, as a fresh verification would find.
    f.grants([])
    await expect(f.s.timesheetDetail(f.c.id, 'h')).rejects.toThrow(/访问权限/)
    f.grants(['timesheet.submit_own', 'approval.record'])
    f.headers[0]!.status = 'approved'
    expect((await f.s.timesheetDetail(f.c.id, 'h')).canEdit).toBe(false)
    f.headers[0]!.status = 'draft'
    f.headers[0]!.employee_id = 'colleague'
    await expect(f.s.timesheetDetail(f.c.id, 'h')).rejects.toThrow(/不属于/)
    expect((await f.s.timesheetDetail(f.c.id, 'h', 'todo')).canEdit).toBe(false)
  })
})

it('rechecks revoked permission before consuming an existing confirmation', async () => {
  const f = await fixture()
  const review = await f.s.timesheetPrepare(f.c.id, { kind: 'create', fields })
  f.registry.markVerified(f.c.id, { ...f.c.identity, permissions: [] })
  const count = f.calls.length
  await expect(f.s.timesheetConfirm(f.c.id, review.id, review.revision, review.token!)).rejects.toThrow('权限')
  expect(f.calls).toHaveLength(count)
  expect((await f.store.list()).find(r => r.id === review.id)?.state).toBe('review')
})
