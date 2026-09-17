import { describe, expect, it, vi } from 'vitest'
import type { RecordConnection, RecordHttp } from '../src/service.js'
import { decodeRecordPage, RecordService } from '../src/service.js'

const connection = {
  origin: 'https://example.invalid',
  identity: {
    permissions: [
      'master_data.manage',
      'expense.submit_own',
      'timesheet.submit_own',
      'approval.record',
      'order.submit_own',
      'inventory.manage',
    ],
    tenant: { id: 't' },
    user: { id: 'u' },
  },
} as RecordConnection
const body = {
  data: [
    {
      id: 'i',
      product_code: 'P-1',
      quantity_on_hand: 0,
      available_to_promise: -2,
      metadata: { password: 'never' },
      secret: 'never',
    },
  ],
  meta: { pages: 2, total: 30 },
}
describe('business record queries', () => {
  it('preserves zero and signed quantities and only exposes named fields', () => {
    const result = decodeRecordPage('inventory-items', body, 1)
    expect(result.rows[0]?.fields).toContainEqual({ label: '现存数量', value: '0' })
    expect(result.rows[0]?.fields).toContainEqual({ label: '可承诺数量', value: '-2' })
    expect(JSON.stringify(result)).not.toContain('never')
    expect(result.total).toBe(30)
  })
  it.each(['sales-orders', 'inventory-items', 'inventory-item-details', 'shipments'] as const)(
    'uses the fixed %s read endpoint with encoded server paging',
    async kind => {
      const request = vi.fn(async () => body),
        service = new RecordService(
          { request } as unknown as RecordHttp,
          async () => connection,
          () => connection,
        )
      await service.recordList({ connectionId: 'c', kind, page: 2, query: 'a&b' })
      const path = request.mock.calls[0]![1].path
      expect(path).toContain(`/${kind}?page=2&size=25&`)
      expect(path).toContain('a%26b')
      expect(request.mock.calls[0]![1]).not.toHaveProperty('body')
    },
  )
  it('rejects arbitrary paths, invalid pages and changed tenant scopes', async () => {
    const request = vi.fn(async () => body),
      service = new RecordService(
        { request } as unknown as RecordHttp,
        async () => connection,
        () => ({ ...connection, origin: 'https://other.invalid' }),
      )
    await expect(
      service.recordList({ connectionId: 'c', kind: '../auth/me' as never, page: 1, query: '' }),
    ).rejects.toThrow()
    await expect(service.recordList({ connectionId: 'c', kind: 'shipments', page: 0, query: '' })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    await expect(service.recordList({ connectionId: 'c', kind: 'shipments', page: 1, query: '' })).rejects.toThrow(
      /连接已变化/,
    )
  })
})

it('resolves ledger products once per position without exposing relation secrets', async () => {
  const request = vi.fn(async (_c, req) =>
    req.path.startsWith('/inventory-item-details?')
      ? {
          data: [
            { id: 'a', inventory_item_id: 'i' },
            { id: 'b', inventory_item_id: 'i' },
          ],
          meta: { pages: 1, total: 2 },
        }
      : { data: { id: 'i', product_code: 'P-1', facility: 'Warehouse', metadata: { secret: 'never' } } },
  )
  const service = new RecordService(
    { request } as unknown as RecordHttp,
    async () => connection,
    () => connection,
  )
  const result = await service.recordList({ connectionId: 'c', kind: 'inventory-item-details', page: 1, query: '' })
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]).toEqual(['c', { path: '/inventory-items/i' }])
  for (const row of result.rows) expect(row.fields).toContainEqual({ label: '产品编码', value: 'P-1' })
  expect(JSON.stringify(result)).not.toContain('never')
})
it('searches product names and codes with server paging and a narrow result schema', async () => {
  const request = vi.fn(async () => ({
    data: [{ id: 'p', name: 'Product', product_code: 'P', metadata: { secret: 'never' } }],
    meta: { total: 22, pages: 2 },
  }))
  const service = new RecordService(
    { request } as unknown as RecordHttp,
    async () => connection,
    () => connection,
  )
  expect(await service.productSearch({ connectionId: 'c', query: 'a&b', page: 2 })).toEqual({
    rows: [{ id: 'p', name: 'Product', code: 'P' }],
    total: 22,
    pages: 2,
  })
  expect(request.mock.calls[0]![1].path).toContain('keyword=a%26b&page=2&size=20')
})
it('rejects invalid or cross-tenant product selection lookup', async () => {
  let current = connection
  const request = vi.fn(async () => {
    current = { ...connection, origin: 'https://other.invalid' }
    return { data: { id: 'p', name: 'Product' } }
  })
  const service = new RecordService(
    { request } as unknown as RecordHttp,
    async () => connection,
    () => current,
  )
  await expect(service.productSearch({ connectionId: 'c', query: '', page: 1, ids: ['p', 'p'] })).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
  await expect(service.productSearch({ connectionId: 'c', query: '', page: 1, ids: ['p'] })).rejects.toThrow()
})
