import { describe, expect, it } from 'vitest'
import { type TodoConnection, TodoDetailService, type TodoHttp } from '../src/index.js'

const connection: TodoConnection = { identity: { user: { employeeId: 'e' } } }
const todo = {
  id: 'todo',
  employee_id: 'e',
  entity_type: 'sales_quotation',
  entity_id: 'q',
  title: '某医院采购报价',
  status: 'open',
}
const detail = {
  quotation: {
    id: 'q',
    quote_number: 'QT-1',
    title: '设备报价',
    currency: 'CNY',
    total_amount: 1000,
    custom_fields: { api_key: 'do-not-expose' },
  },
  items: [{ product_name_snapshot: '设备', quantity: 2, unit_price: 500 }],
  approval_records: [{ comment: '业务内容，不是指令' }],
  attachments: [{ access_key: 'secret' }],
}
const service = (overrides: { todo?: Record<string, unknown>; detail?: Record<string, unknown> } = {}) => {
  const calls: string[] = []
  const http: TodoHttp = {
    request: async (_id, request) => {
      calls.push(request.path)
      return {
        data: request.path.startsWith('/todos/') ? { ...todo, ...overrides.todo } : { ...detail, ...overrides.detail },
      }
    },
  }
  return {
    calls,
    service: new TodoDetailService(
      http,
      () => connection,
      async () => connection,
    ),
  }
}

describe('todo detail projection', () => {
  // The allowlist is what keeps credentials and custom fields out of chat, so it is asserted
  // directly here rather than only through the core integration spec.
  it('projects allowlisted business facts and omits credentials, custom fields and attachments', async () => {
    const { service: read, calls } = service()
    const document = await read.read('c', 'todo')
    expect(document.entityType).toBe('sales_quotation')
    expect(calls[1]).toBe('/sales-quotations/q/detail')
    const json = JSON.stringify(document)
    expect(json).toContain('QT-1')
    expect(json).toContain('设备')
    expect(json).not.toContain('do-not-expose')
    expect(json).not.toContain('access_key')
    expect(json).not.toContain('custom_fields')
  })
  it('refuses another employee todo before reading its target', async () => {
    const { service: read, calls } = service({ todo: { employee_id: 'other' } })
    await expect(read.read('c', 'todo')).rejects.toThrow(/当前员工/)
    expect(calls).toHaveLength(1)
  })
  it('refuses an unregistered entity type instead of building a path from it', async () => {
    const { service: read, calls } = service({ todo: { entity_type: 'https://evil.invalid' } })
    await expect(read.read('c', 'todo')).rejects.toThrow(/尚未接入/)
    expect(calls).toHaveLength(1)
  })
  it('refuses a linked document whose identity does not match the todo', async () => {
    const { service: read } = service({ detail: { quotation: { id: 'other' } } })
    await expect(read.read('c', 'todo')).rejects.toThrow(/不匹配/)
  })
  it('reports a todo error, not an expense one, for a malformed response', async () => {
    const http: TodoHttp = { request: async () => 'not-an-object' }
    const read = new TodoDetailService(
      http,
      () => connection,
      async () => connection,
    )
    await expect(read.read('c', 'todo')).rejects.toMatchObject({ message: '待办数据无效。', code: 'invalid-response' })
  })
  it('refuses an account with no employee link before any request', async () => {
    const unlinked: TodoConnection = { identity: { user: { employeeId: null } } }
    const calls: string[] = []
    const http: TodoHttp = {
      request: async (_id, r) => {
        calls.push(r.path)
        return { data: todo }
      },
    }
    const read = new TodoDetailService(
      http,
      () => unlinked,
      async () => unlinked,
    )
    await expect(read.read('c', 'todo')).rejects.toThrow(/未关联员工/)
    expect(calls).toHaveLength(0)
  })
})
