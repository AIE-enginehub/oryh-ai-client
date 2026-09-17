import { describe, expect, it, vi } from 'vitest'
import type { RecordFilterField } from '../src/contracts.js'
import type { RecordConnection, RecordHttp } from '../src/service.js'
import { RecordService } from '../src/service.js'

const connection = {
  origin: 'https://example.invalid',
  identity: { permissions: ['inventory.manage', 'order.submit_own'], tenant: { id: 't' }, user: { id: 'u' } },
} as unknown as RecordConnection
const body = { data: [], meta: { pages: 1, total: 0 } }
/** What `GET /shipments` declares on a real deployment, minus paging and sort. */
const shipmentFields: RecordFilterField[] = [
  { name: 'direction', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'include_deleted', type: 'boolean' },
  { name: 'keyword', type: 'string' },
]

// `null`, not `undefined`, means "no lookup": an `undefined` argument would take the default instead.
function service(declared: RecordFilterField[] | null = shipmentFields) {
  const request = vi.fn(async () => body)
  const lookup = declared === null ? undefined : vi.fn(async () => declared)
  return {
    request,
    lookup,
    records: new RecordService(
      { request } as unknown as RecordHttp,
      async () => connection,
      () => connection,
      lookup,
    ),
  }
}

describe('server-side record filters', () => {
  it('sends declared filters as query parameters, so the server does the filtering', async () => {
    const { request, lookup, records } = service()
    await records.recordList({
      connectionId: 'c',
      kind: 'shipments',
      page: 1,
      query: '',
      filters: { direction: 'inbound', status: 'draft' },
    })
    const path = request.mock.calls[0]![1].path
    expect(path).toContain('direction=inbound')
    expect(path).toContain('status=draft')
    // Filtering is the server's job: a view that filtered only the loaded page would drop every row past it.
    expect(path).toContain('page=1&size=25')
    expect(lookup).toHaveBeenCalledWith('c', '/shipments')
  })

  it('refuses a key the endpoint does not declare, because the server would silently ignore it', async () => {
    const { request, records } = service()
    // The failure this guards against: an unfiltered list shown under a label that says it is filtered.
    await expect(
      records.recordList({
        connectionId: 'c',
        kind: 'shipments',
        page: 1,
        query: '',
        filters: { directon: 'inbound' },
      }),
    ).rejects.toThrow(/不支持按“directon”筛选.*direction/)
    expect(request).not.toHaveBeenCalled()
  })

  it('holds a value to the type the endpoint declares', async () => {
    const { records } = service()
    await expect(
      records.recordList({
        connectionId: 'c',
        kind: 'shipments',
        page: 1,
        query: '',
        filters: { include_deleted: 'yes' },
      }),
    ).rejects.toThrow(/true 或 false/)
    await expect(
      records.recordList({ connectionId: 'c', kind: 'shipments', page: 1, query: '', filters: { direction: '' } }),
    ).rejects.toThrow(/值不能为空/)
  })

  it('does not let a filter fight the search box over the same parameter', async () => {
    const { records } = service()
    await expect(
      records.recordList({
        connectionId: 'c',
        kind: 'shipments',
        page: 1,
        query: 'SF123',
        filters: { keyword: 'other' },
      }),
    ).rejects.toThrow(/搜索框/)
    // With the box empty the same key is an ordinary filter.
    await expect(
      records.recordList({ connectionId: 'c', kind: 'shipments', page: 1, query: '', filters: { keyword: 'other' } }),
    ).resolves.toBeDefined()
  })

  it('refuses filters outright when the deployment cannot say what it accepts', async () => {
    const { request, records } = service(null)
    // Sending them unchecked is exactly the silent-ignore risk; refusing is the only safe answer.
    await expect(
      records.recordList({
        connectionId: 'c',
        kind: 'shipments',
        page: 1,
        query: '',
        filters: { direction: 'inbound' },
      }),
    ).rejects.toThrow(/无法读取/)
    expect(request).not.toHaveBeenCalled()
    // A list with no filters still works exactly as before.
    await expect(
      records.recordList({ connectionId: 'c', kind: 'shipments', page: 1, query: '' }),
    ).resolves.toBeDefined()
  })

  it('reports what a list can be filtered by, for a person who may open it', async () => {
    const { records } = service()
    expect((await records.recordFilterFields('c', 'shipments')).map(f => f.name)).toEqual([
      'direction',
      'status',
      'include_deleted',
      'keyword',
    ])
    await expect(records.recordFilterFields('c', '../auth/me' as never)).rejects.toThrow()
  })
})

describe('filters alongside a product query', () => {
  it('applies declared filters to every movement read, so the product query stays server-filtered', async () => {
    const request = vi.fn(async (_c: unknown, req: { path: string }) =>
      req.path.startsWith('/inventory-items?')
        ? { data: [{ id: 'i1', product_id: 'p1', product_code: 'P-1' }], meta: { total: 1, pages: 1 } }
        : {
            data: [{ id: 'd1', inventory_item_id: 'i1', effective_at: '2026-09-01', created_at: '2026-09-01' }],
            meta: { total: 1, pages: 1 },
          },
    )
    const detailFields: RecordFilterField[] = [
      { name: 'inventory_item_id', type: 'string' },
      { name: 'reason', type: 'string' },
    ]
    const records = new RecordService(
      { request } as unknown as RecordHttp,
      async () => connection,
      () => connection,
      async () => detailFields,
    )
    await records.recordList({
      connectionId: 'c',
      kind: 'inventory-item-details',
      page: 1,
      query: '',
      productIds: ['p1'],
      filters: { reason: 'sale' },
    })
    const detailRead = request.mock.calls.map(c => c[1].path).find(p => p.startsWith('/inventory-item-details?'))
    expect(detailRead).toContain('inventory_item_id=i1')
    expect(detailRead).toContain('reason=sale')
  })

  it('refuses an inventory-item filter, which the product query already decides', async () => {
    const records = new RecordService(
      { request: vi.fn() } as unknown as RecordHttp,
      async () => connection,
      () => connection,
      async () => [{ name: 'inventory_item_id', type: 'string' }],
    )
    await expect(
      records.recordList({
        connectionId: 'c',
        kind: 'inventory-item-details',
        page: 1,
        query: '',
        productIds: ['p1'],
        filters: { inventory_item_id: 'x' },
      }),
    ).rejects.toThrow(/库存项编号/)
  })
})
