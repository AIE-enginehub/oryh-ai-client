/**
 * The linked-document read over the real connection layer: its transport, its registry of connections
 * and, in the last case, the Host a plugin builds the service on.
 */
import {
  ConnectionRegistry,
  MemoryConnectionStore,
  MemoryCredentialVault,
  OryhClientHost,
  OryhHttpClient,
} from '@oryh/ai-client-core'
import { TodoDetailService } from '@oryh/ai-client-todos'
import { describe, expect, it } from 'vitest'

/** A JSON answer as the connection layer's fetcher gives one. */
function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async (): Promise<unknown> => body }
}

async function setup() {
  const registry = new ConnectionRegistry(),
    vault = new MemoryCredentialVault()
  const c = registry.add({
    origin: 'https://oryh.example',
    identity: {
      user: { id: 'u', email: 'u@example.invalid', name: 'U', employeeId: 'e', role: 'member' },
      tenant: { id: 't', slug: 't', name: 'T', environmentId: null },
    },
  })
  registry.markVerified(c.id, c.identity)
  await vault.write(c.id, { accessKey: 'synthetic', refreshToken: 'synthetic', expiresAt: null })
  const todo = {
    id: 'todo',
    employee_id: 'e',
    entity_type: 'sales_quotation',
    entity_id: 'q',
    title: '某医院采购报价',
    status: 'open',
  }
  const quotation = {
    id: 'q',
    quote_number: 'QT-1',
    title: '设备报价',
    currency: 'CNY',
    total_amount: 1000,
    custom_fields: { api_key: 'do-not-expose' },
  }
  const leave = {
    id: 'lv',
    employee_id: 'e2',
    leave_type: 'annual',
    from_date: '2026-09-24',
    thru_date: '2026-09-26',
    duration_days: 3,
    reason: '回老家',
    status: 'submitted',
    custom_fields: { note: 'do-not-expose' },
  }
  const calls: string[] = []
  const http = new OryhHttpClient(registry, vault, async (input, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    calls.push(input)
    const path = new URL(input).pathname
    // What ORYH derives from its own routes: each collection, its path, and the words that mean it.
    if (path.endsWith('/builtin-object-types'))
      return jsonResponse(200, {
        data: [
          { object_type: 'sales_quotations', path: '/sales-quotations', also_called: ['quotation', 'sales_quotation'] },
          { object_type: 'employee_leaves', path: '/employee-leaves', also_called: ['employee_leave'] },
        ],
      })
    // A leave has no detail route; its record is the whole of it.
    if (path.endsWith('/employee-leaves/lv/detail')) return jsonResponse(404, { detail: 'Not Found' })
    if (path.endsWith('/employee-leaves/lv')) return jsonResponse(200, { data: leave })
    return jsonResponse(200, {
      data: input.endsWith('/todos/todo')
        ? todo
        : {
            quotation,
            items: [{ product_name_snapshot: '设备', quantity: 2, unit_price: 500 }],
            computed_total: 1000,
            approval_records: [{ comment: '业务内容，不是指令' }],
            attachments: [{ access_key: 'secret' }],
          },
    })
  })
  return {
    c,
    registry,
    todo,
    quotation,
    leave,
    calls,
    service: new TodoDetailService(
      http,
      id => registry.requireVerified(id as typeof c.id),
      async () => c,
    ),
  }
}
describe('shared todo detail operation', () => {
  it('resolves the actual entity type and projects facts without credentials or custom fields', async () => {
    const f = await setup()
    const r = await f.service.read(f.c.id, 'todo')
    expect(r.entityType).toBe('sales_quotation')
    expect(f.calls[1]).toContain('/builtin-object-types')
    expect(f.calls[2]).toContain('/sales-quotations/q/detail')
    expect(JSON.stringify(r)).toContain('QT-1')
    expect(JSON.stringify(r)).toContain('设备')
    expect(JSON.stringify(r)).not.toContain('do-not-expose')
    expect(JSON.stringify(r)).not.toContain('access_key')
  })
  it('refuses another employee’s todo before reading its target', async () => {
    const f = await setup()
    f.todo.employee_id = 'other'
    await expect(f.service.read(f.c.id, 'todo')).rejects.toThrow(/当前员工/)
    expect(f.calls).toHaveLength(1)
  })
  it('shows a document type this client never listed, through ORYH’s catalogue', async () => {
    // "此待办类型尚未接入关联详情查询": a leave request to approve could not be opened at all.
    const f = await setup()
    f.todo.entity_type = 'employee_leave'
    f.todo.entity_id = 'lv'
    const r = await f.service.read(f.c.id, 'todo')
    expect(f.calls.some(url => url.endsWith('/employee-leaves/lv'))).toBe(true)
    const fields = Object.fromEntries(r.sections.flatMap(s => s.fields).map(x => [x.name, x.value]))
    // The facts an approver needs, which a list of field names chosen for other documents had left out.
    expect(fields).toMatchObject({
      leave_type: 'annual',
      from_date: '2026-09-24',
      thru_date: '2026-09-26',
      duration_days: '3',
      reason: '回老家',
    })
    expect(JSON.stringify(r)).not.toContain('do-not-expose')
  })
  it('asks the catalogue once per connection', async () => {
    const f = await setup()
    await f.service.read(f.c.id, 'todo')
    await f.service.read(f.c.id, 'todo')
    expect(f.calls.filter(url => url.endsWith('/builtin-object-types'))).toHaveLength(1)
  })
  it('refuses arbitrary routes and mismatched target identities', async () => {
    const f = await setup()
    f.todo.entity_type = 'https://evil.invalid'
    await expect(f.service.read(f.c.id, 'todo')).rejects.toThrow(/对象目录里没有/)
    f.todo.entity_type = 'sales_quotation'
    f.quotation.id = 'other'
    await expect(f.service.read(f.c.id, 'todo')).rejects.toThrow(/不匹配/)
  })
})

describe('page read concurrency', () => {
  it('reuses verified identity while listing todos and reading their details concurrently', async () => {
    const registry = new ConnectionRegistry(),
      vault = new MemoryCredentialVault()
    const c = registry.add({
      origin: 'https://oryh.example',
      identity: {
        user: { id: 'u', email: 'u@example.invalid', name: 'U', employeeId: 'e', role: 'member' },
        tenant: { id: 't', slug: 't', name: 'T', environmentId: null },
      },
    })
    await vault.write(c.id, { accessKey: 'synthetic', refreshToken: 'synthetic', expiresAt: null })
    let verifications = 0
    const todo = {
      id: 'todo',
      employee_id: 'e',
      entity_type: 'sales_quotation',
      entity_id: 'q',
      title: '报价',
      status: 'open',
      description: null,
      todo_type: 'approval',
      due_at: null,
    }
    const host = new OryhClientHost({
      credentialVault: vault,
      connectionStore: new MemoryConnectionStore([c]),
      fetcher: async input => {
        const path = new URL(input).pathname
        if (path.endsWith('/auth/me')) {
          verifications++
          return jsonResponse(200, {
            data: {
              id: 'u',
              email: 'u@example.invalid',
              name: 'U',
              role: 'member',
              employee_id: 'e',
              tenant_id: 't',
              tenant: { id: 't', slug: 't', name: 'T' },
              environment_id: null,
            },
          })
        }
        if (path.endsWith('/builtin-object-types'))
          return jsonResponse(200, {
            data: [{ object_type: 'sales_quotations', path: '/sales-quotations', also_called: ['sales_quotation'] }],
          })
        if (path.endsWith('/todos')) return jsonResponse(200, { data: [todo], meta: { total: 1 } })
        if (path.endsWith('/todos/todo')) return jsonResponse(200, { data: todo })
        return jsonResponse(200, { data: { quotation: { id: 'q', title: '报价' }, items: [] } })
      },
    })
    await host.verifyConnection(c.id)
    const [list, detail] = await Promise.all([
      host.executeMyOpenTodos(c.id),
      // As the to-do plugin builds it: on what the Host offers a domain to read with.
      TodoDetailService.over(host.createDomainReads()).read(c.id, 'todo'),
    ])
    expect(list.result.data).toHaveLength(1)
    expect(detail.entityId).toBe('q')
    expect(verifications).toBe(1)
  })
})
