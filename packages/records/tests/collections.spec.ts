import { OryhClientError } from '@oryh/ai-client-foundation'
import { describe, expect, it, vi } from 'vitest'
import type { RecordDisplay, RecordFilterField } from '../src/contracts.js'
import type { RecordConnection, RecordHttp } from '../src/service.js'
import { RecordService } from '../src/service.js'

/** Someone who may handle orders but not inventory; which lists they get is ORYH's to say. */
const connection = {
  origin: 'https://example.invalid',
  identity: {
    permissions: ['order.submit_own'],
    tenant: { id: 't' },
    user: { id: 'u', employeeId: 'e' },
  },
} as unknown as RecordConnection

/** What `GET /sales-order-items` declares on a real deployment, minus paging and sort. */
const declared: RecordFilterField[] = [
  { name: 'order_id', type: 'string' },
  { name: 'product_id', type: 'string' },
]

const display: RecordDisplay = {
  title: 'product_name_snapshot',
  date: 'created_at',
  columns: [
    { field: 'line_no', label: '行号' },
    { field: 'product_name_snapshot', label: '产品' },
    { field: 'quantity', label: '数量' },
  ],
}

function service(rows: unknown[] = []) {
  const request = vi.fn(async () => ({ data: rows, meta: { pages: 1, total: rows.length } }))
  const lookup = vi.fn(async () => declared)
  return {
    request,
    records: new RecordService(
      { request } as unknown as RecordHttp,
      async () => connection,
      () => connection,
      lookup,
    ),
  }
}

describe('a list of any collection', () => {
  it('reads a collection this client has never heard of, shown as the entry says', async () => {
    const f = service([
      { id: 'i-1', line_no: 1, product_name_snapshot: '高速机', quantity: 2, created_at: '2026-09-01' },
    ])
    const page = await f.records.collectionList({
      connectionId: 'c',
      collection: 'sales-order-items',
      page: 1,
      filters: { order_id: 'so-1' },
      display,
    })
    expect(f.request).toHaveBeenCalledWith('c', { path: '/sales-order-items?page=1&size=25&order_id=so-1' })
    expect(page.rows[0]).toMatchObject({
      id: 'i-1',
      title: '高速机',
      date: '2026-09-01',
      fields: [
        { label: '编号', value: 'i-1' },
        { label: '行号', value: '1' },
        { label: '产品', value: '高速机' },
        { label: '数量', value: '2' },
      ],
    })
  })

  it('refuses a filter the endpoint does not declare, rather than returning every row under a narrowed name', async () => {
    const f = service()
    await expect(
      f.records.collectionList({
        connectionId: 'c',
        collection: 'sales-order-items',
        page: 1,
        filters: { directon: 'inbound' },
        display,
      }),
    ).rejects.toThrow('不支持按')
    expect(f.request).not.toHaveBeenCalled()
  })

  it('puts no rule of its own in front of a collection: ORYH answers for every one', async () => {
    const f = service()
    // This identity has no inventory grant. The client used to refuse the list for that; ORYH is asked now.
    await expect(
      f.records.collectionList({ connectionId: 'c', collection: 'inventory-items', page: 1, display }),
    ).resolves.toBeDefined()
    await expect(
      f.records.collectionList({ connectionId: 'c', collection: 'sales-order-items', page: 1, display }),
    ).resolves.toBeDefined()
  })

  it('refuses a collection name that is not one, before asking the deployment', async () => {
    const f = service()
    for (const collection of ['../secrets', 'Sales-Orders', '', 'a'.repeat(80)]) {
      await expect(f.records.collectionList({ connectionId: 'c', collection, page: 1, display })).rejects.toThrow()
    }
    expect(f.request).not.toHaveBeenCalled()
  })
})

describe("a document's child tables", () => {
  /** Trimmed from a real `GET /sales-orders/{id}/detail`. */
  const detail = {
    data: {
      revision: 3,
      order: { id: 'so-1', order_no: 'SO-001' },
      items: [
        {
          id: 'i-1',
          tenant_id: 't',
          order_id: 'so-1',
          line_no: 1,
          product_name_snapshot: '高速机',
          quantity: 2,
          custom_fields: {},
        },
        {
          id: 'i-2',
          tenant_id: 't',
          order_id: 'so-1',
          line_no: 2,
          product_name_snapshot: '色带',
          quantity: 1200,
          promised_date: '2026-07-07',
        },
      ],
      approval_records: [{ id: 'a-1', action: 'approved', comment: '同意' }],
      attachments: [],
      computed_total: 100,
    },
  }

  function detailService(answer: () => Promise<unknown>) {
    const request = vi.fn(answer)
    return {
      request,
      records: new RecordService(
        { request } as unknown as RecordHttp,
        async () => connection,
        () => connection,
      ),
    }
  }

  it("shows every array of records ORYH's detail returns, under names a person reads", async () => {
    const f = detailService(async () => detail)
    const { children } = await f.records.recordDetail('c', 'sales-orders', 'so-1')
    expect(f.request).toHaveBeenCalledWith('c', { path: '/sales-orders/so-1/detail' })
    expect(children.map(c => [c.key, c.label])).toEqual([
      ['items', '明细行'],
      ['approval_records', '审批记录'],
    ])
    const items = children[0]!
    // Columns are the union across rows, in first-seen order. Not columns: the tenant, nested objects, the
    // row's own id, and `order_id`, which names this very order on every row.
    expect(items.columns.map(c => c.field)).toEqual(['line_no', 'product_name_snapshot', 'quantity', 'promised_date'])
    expect(items.columns.find(c => c.field === 'product_name_snapshot')?.label).toBe('产品名称')
    expect(items.rows[1]).toMatchObject({
      product_name_snapshot: '色带',
      quantity: '1200',
      promised_date: '2026-07-07',
    })
    expect(items.rows[0]!.promised_date).toBe('')
  })

  it('reads a collection with no detail route as having no child tables', async () => {
    const f = detailService(async () => {
      throw new OryhClientError('not found', 'request-failed', 404)
    })
    await expect(f.records.recordDetail('c', 'sales-order-items', 'i-1')).resolves.toEqual({ children: [] })
  })

  it('refuses an id that would step outside the document', async () => {
    const f = detailService(async () => detail)
    for (const id of ['../x', 'a/b', 'a?b', ''])
      await expect(f.records.recordDetail('c', 'sales-orders', id)).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
  })
})
