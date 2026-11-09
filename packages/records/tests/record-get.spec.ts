import { describe, expect, it, vi } from 'vitest'
import type { RecordConnection, RecordHttp } from '../src/service.js'
import { RecordService } from '../src/service.js'

const person = (permissions: string[]) =>
  ({
    origin: 'https://example.invalid',
    identity: { permissions, tenant: { id: 't' }, user: { id: 'u', employeeId: 'e' } },
  }) as unknown as RecordConnection

function service(answer: (path: string) => unknown, connection = person(['order.submit_own', 'inventory.read'])) {
  const request = vi.fn(async (_id: string, r: { path: string }) => answer(r.path))
  return {
    request,
    records: new RecordService(
      { request } as unknown as RecordHttp,
      async () => connection,
      () => connection,
    ),
  }
}

const ORDER = '2df5ffdc-2924-4978-8ab1-ac335733d941'

describe('one record of a built-in list, by id', () => {
  it('reads the record through the list’s own route and shows it as a row of that list', async () => {
    const f = service(() => ({
      data: { id: ORDER, order_no: 'SO202606002', title: '滨江订单', status: 'shipped', order_date: '2026-06-24' },
    }))
    const record = await f.records.recordGet('c', 'sales-orders', ORDER)
    expect(f.request).toHaveBeenCalledWith('c', { path: `/sales-orders/${ORDER}` })
    expect(record).toMatchObject({ id: ORDER, status: 'shipped' })
    expect(record.fields[0]).toEqual({ field: 'id', label: '编号', value: ORDER })
    // The same columns a row of the list carries, so the detail reads the same whichever way it was opened.
    const listed = await service(() => ({
      data: [{ id: ORDER, order_no: 'SO202606002', title: '滨江订单', status: 'shipped', order_date: '2026-06-24' }],
      meta: { pages: 1, total: 1 },
    })).records.recordList({ connectionId: 'c', kind: 'sales-orders', page: 1, query: '' })
    expect(record).toEqual(listed.rows[0])
  })

  it('refuses an answer about another record and an id that is not one, and leaves who may read to ORYH', async () => {
    const other = service(() => ({ data: { id: 'someone-elses', status: 'draft' } }))
    await expect(other.records.recordGet('c', 'sales-orders', ORDER)).rejects.toThrow(/无效/)
    const f = service(() => ({ data: { id: ORDER } }))
    for (const bad of ['', '../shipments', 'a/b', 'x?y=1', 'a'.repeat(201)])
      await expect(f.records.recordGet('c', 'sales-orders', bad)).rejects.toThrow()
    await expect(f.records.recordGet('c', 'nonsense' as never, ORDER)).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
    // Someone with no grant this client used to ask for is not refused here: ORYH is asked as them, and
    // its refusal is what they are told.
    const refusal = new Error('ORYH 没有允许当前账号读取或办理这项内容（HTTP 403）。权限由 ORYH 的管理员设置。')
    const barred = service(() => {
      throw refusal
    }, person([]))
    await expect(barred.records.recordGet('c', 'sales-orders', ORDER)).rejects.toBe(refusal)
    expect(barred.request).toHaveBeenCalledTimes(1)
  })
})

describe('one record of a collection a menu entry names, by id', () => {
  const display = {
    title: 'invoice_no',
    columns: [
      { field: 'invoice_no', label: '发票号' },
      { field: 'amount', label: '金额' },
    ],
  }
  it('reads the record through the collection’s own route and shows it as the entry shows its rows', async () => {
    const f = service(() => ({ data: { id: 'inv-1', invoice_no: 'FP-001', amount: '120.00', status: 'unpaid' } }))
    const record = await f.records.collectionGet({ connectionId: 'c', collection: 'invoices', id: 'inv-1', display })
    expect(f.request).toHaveBeenCalledWith('c', { path: '/invoices/inv-1' })
    // Titled and laid out as the entry says, like any row of its list.
    expect(record).toMatchObject({ id: 'inv-1', title: 'FP-001', status: 'unpaid' })
    expect(record.fields).toEqual(
      expect.arrayContaining([
        { field: 'invoice_no', label: '发票号', value: 'FP-001' },
        { field: 'amount', label: '金额', value: '120.00' },
      ]),
    )
  })

  it('refuses an answer about another record and an id or a collection that is not one, and leaves who may read to ORYH', async () => {
    const other = service(() => ({ data: { id: 'someone-elses' } }))
    await expect(
      other.records.collectionGet({ connectionId: 'c', collection: 'invoices', id: 'inv-1', display }),
    ).rejects.toThrow(/无效/)
    const f = service(() => ({ data: { id: 'inv-1' } }))
    for (const id of ['', '../x', 'a/b', 'x?y=1', 'a b', 'a'.repeat(201)])
      await expect(
        f.records.collectionGet({ connectionId: 'c', collection: 'invoices', id, display }),
      ).rejects.toThrow()
    await expect(
      f.records.collectionGet({ connectionId: 'c', collection: '../auth', id: 'inv-1', display }),
    ).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
    // Who may read sales orders is ORYH's to say: the read is made as this person, with no rule of this
    // client's in front of it.
    const open = service(() => ({ data: { id: 'so-1' } }), person([]))
    await expect(
      open.records.collectionGet({ connectionId: 'c', collection: 'sales-orders', id: 'so-1', display }),
    ).resolves.toMatchObject({ id: 'so-1' })
    expect(open.request).toHaveBeenCalledTimes(1)
  })
})
