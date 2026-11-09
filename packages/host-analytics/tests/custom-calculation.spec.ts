import type { BusinessRecord } from '@oryh/ai-client-records'
import { describe, expect, it } from 'vitest'
import { calculateRows, jsonDataset, localTime, recordsDataset } from '../src/custom-calculation.js'
import { customDefinitionSchema } from '../src/custom-model.js'

const source = customDefinitionSchema.parse({
  title: '订单统计',
  html: '<main></main>',
  css: '',
  script: '',
  fixedText: '',
  task: {
    instruction: '按客户与币种分别统计销售订单金额。',
    timeZone: 'Asia/Shanghai',
    sources: [
      {
        collection: 'sales-orders',
        filters: {},
        display: {
          columns: [
            { field: 'customer', label: '客户' },
            { field: 'currency', label: '币种' },
            { field: 'amount', label: '金额' },
          ],
        },
      },
    ],
    contract: { fields: [{ name: 'total', type: 'array', required: true }] },
  },
}).task.sources[0]!

function row(id: string, customer: string, currency: string, amount: string): BusinessRecord {
  return {
    id,
    title: id,
    status: '',
    summary: '',
    date: '',
    fields: [
      { label: '编号', value: id },
      { label: '客户', value: customer },
      { label: '币种', value: currency },
      { label: '金额', value: amount },
    ],
  }
}

describe('custom page exact calculation', () => {
  const rows = [row('a', '甲', 'CNY', '0.1'), row('b', '甲', 'CNY', '0.2'), row('c', '甲', 'USD', '1.3')]
  it('keeps currencies separate, sums decimals exactly and retains source ids', () => {
    expect(
      calculateRows(recordsDataset(source, rows), {
        collection: 'sales-orders',
        operation: 'sum',
        groupBy: 'customer',
        measure: 'amount',
        unitField: 'currency',
      }).groups,
    ).toEqual([
      { group: '甲', unit: 'CNY', count: 2, value: '0.3', rowIds: ['a', 'b'] },
      { group: '甲', unit: 'USD', count: 1, value: '1.3', rowIds: ['c'] },
    ])
  })
  it('counts all rows, including an empty source, without inventing grouped categories', () => {
    expect(
      calculateRows(recordsDataset(source, rows), { collection: 'sales-orders', operation: 'count' }).groups,
    ).toEqual([{ group: null, unit: null, count: 3, value: '3', rowIds: ['a', 'b', 'c'] }])
    expect(
      calculateRows(recordsDataset(source, []), { collection: 'sales-orders', operation: 'count' }).groups[0]?.value,
    ).toBe('0')
    expect(
      calculateRows(recordsDataset(source, []), { collection: 'sales-orders', operation: 'count', groupBy: 'customer' })
        .groups,
    ).toEqual([])
  })
  it('rejects missing units, unknown fields, missing values and unsupported precision', () => {
    expect(() =>
      calculateRows(recordsDataset(source, rows), { collection: 'sales-orders', operation: 'sum', measure: 'amount' }),
    ).toThrow('单位字段')
    expect(() =>
      calculateRows(recordsDataset(source, rows), {
        collection: 'sales-orders',
        operation: 'count',
        groupBy: 'secret',
      }),
    ).toThrow('不在数据集')
    expect(() =>
      calculateRows(recordsDataset(source, [row('a', '甲', '—', '1')]), {
        collection: 'sales-orders',
        operation: 'sum',
        measure: 'amount',
        unitField: 'currency',
      }),
    ).toThrow('单位字段缺失')
    expect(() =>
      calculateRows(recordsDataset(source, [row('a', '甲', 'CNY', '1.0000001')]), {
        collection: 'sales-orders',
        operation: 'sum',
        measure: 'amount',
        unitField: 'currency',
      }),
    ).toThrow('精度')
  })
})

describe('filters, buckets and joins', () => {
  const orders = customDefinitionSchema.parse({
    title: '订单统计',
    html: '<main></main>',
    css: '',
    script: '',
    fixedText: '',
    task: {
      instruction: '按客户统计本月订单与发货。',
      timeZone: 'Asia/Shanghai',
      sources: [
        {
          collection: 'sales-orders',
          filters: {},
          display: {
            columns: [
              { field: 'customer', label: '客户' },
              { field: 'status', label: '状态' },
              { field: 'ordered_at', label: '下单时间' },
              { field: 'currency', label: '币种' },
              { field: 'amount', label: '金额' },
            ],
          },
        },
        {
          collection: 'shipments',
          filters: {},
          display: {
            columns: [
              { field: 'order_id', label: '订单' },
              { field: 'carrier', label: '承运商' },
            ],
          },
        },
      ],
      contract: { fields: [{ name: 'rows', type: 'array', required: true }] },
    },
  }).task.sources
  const order = (id: string, customer: string, status: string, at: string, amount: string): BusinessRecord => ({
    id,
    title: id,
    status,
    summary: '',
    date: '',
    fields: [
      { label: '编号', value: id },
      { label: '客户', value: customer },
      { label: '状态', value: status },
      { label: '下单时间', value: at },
      { label: '币种', value: 'CNY' },
      { label: '金额', value: amount },
    ],
  })
  const shipment = (id: string, orderId: string, carrier: string): BusinessRecord => ({
    id,
    title: id,
    status: '',
    summary: '',
    date: '',
    fields: [
      { label: '编号', value: id },
      { label: '订单', value: orderId },
      { label: '承运商', value: carrier },
    ],
  })
  // 2026-08-31T16:30Z is already September 1st in Shanghai; 2026-09-30T16:30Z is October 1st there.
  const rows = [
    order('o1', '甲', 'open', '2026-08-31T16:30:00Z', '10'),
    order('o2', '甲', 'delivered', '2026-09-15T02:00:00Z', '20'),
    order('o3', '乙', 'open', '2026-09-30T16:30:00Z', '5'),
    order('o4', '乙', 'open', '2026-09-02', '7'),
  ]
  const shipments = [shipment('s1', 'o1', '顺丰'), shipment('s2', 'o2', '顺丰')]
  const others = new Map([
    ['sales-orders', recordsDataset(orders[0]!, rows)],
    ['shipments', recordsDataset(orders[1]!, shipments)],
  ])
  const context = { timeZone: 'Asia/Shanghai', others }

  it('reads an instant as the page time zone does', () => {
    expect(localTime('2026-08-31T16:30:00Z', 'Asia/Shanghai')).toBe('2026-09-01T00:30:00')
    expect(localTime('2026-09-02', 'Asia/Shanghai')).toBe('2026-09-02')
    expect(() => localTime('昨天', 'Asia/Shanghai')).toThrow('不是可比较的日期')
  })
  it('bounds a month in the page time zone and sums only what is not delivered', () => {
    const result = calculateRows(
      recordsDataset(orders[0]!, rows),
      {
        collection: 'sales-orders',
        operation: 'sum',
        groupBy: 'customer',
        measure: 'amount',
        unitField: 'currency',
        where: [
          { field: 'ordered_at', op: 'from', value: '2026-09-01' },
          { field: 'ordered_at', op: 'before', value: '2026-10-01' },
          { field: 'status', op: 'not_in', value: ['delivered', 'cancelled'] },
        ],
      },
      context,
    )
    expect(result.matchedRows).toBe(2)
    // Labels sort as Chinese readers expect, the way the old analyses did.
    expect(result.groups.map(g => [g.group, g.value])).toEqual([
      ['甲', '10'],
      ['乙', '7'],
    ])
  })
  it('groups by several fields and by month', () => {
    const result = calculateRows(
      recordsDataset(orders[0]!, rows),
      { collection: 'sales-orders', operation: 'count', groupBy: ['customer', 'ordered_at@month'] },
      context,
    )
    expect(result.groups.map(g => [g.group, g.value])).toEqual([
      [['甲', '2026-09'], '2'],
      [['乙', '2026-09'], '1'],
      [['乙', '2026-10'], '1'],
    ])
  })
  it('joins another fully read source by key, and says so when rows find no partner', () => {
    const joined = calculateRows(
      recordsDataset(orders[1]!, shipments),
      {
        collection: 'shipments',
        operation: 'count',
        groupBy: 'sales-orders.customer',
        join: { collection: 'sales-orders', localField: 'order_id' },
      },
      context,
    )
    expect(joined.groups.map(g => [g.group, g.value])).toEqual([['甲', '2']])
    const stray = [...shipments, shipment('s3', 'o9', '中通')]
    expect(() =>
      calculateRows(
        recordsDataset(orders[1]!, stray),
        { collection: 'shipments', operation: 'count', join: { collection: 'sales-orders', localField: 'order_id' } },
        context,
      ),
    ).toThrow('找不到对应项')
    const excluded = calculateRows(
      recordsDataset(orders[1]!, stray),
      {
        collection: 'shipments',
        operation: 'count',
        join: { collection: 'sales-orders', localField: 'order_id', unmatched: 'exclude' },
      },
      context,
    )
    expect(excluded.excluded).toEqual({ count: 1, rowIds: ['s3'] })
    expect(excluded.groups[0]?.value).toBe('2')
    expect(() =>
      calculateRows(
        recordsDataset(orders[1]!, shipments),
        { collection: 'shipments', operation: 'count', groupBy: 'customers.name' },
        context,
      ),
    ).toThrow('不在数据集')
  })
  it('counts distinct values and refuses a key that is not unique', () => {
    expect(
      calculateRows(
        recordsDataset(orders[0]!, rows),
        { collection: 'sales-orders', operation: 'count_distinct', measure: 'customer' },
        context,
      ).groups[0]?.value,
    ).toBe('2')
    const doubled = new Map([
      ...others,
      ['sales-orders', recordsDataset(orders[0]!, [...rows, order('o1', '丙', 'open', '2026-09-03', '1')])],
    ])
    expect(() =>
      calculateRows(
        recordsDataset(orders[1]!, shipments),
        { collection: 'shipments', operation: 'count', join: { collection: 'sales-orders', localField: 'order_id' } },
        { timeZone: 'Asia/Shanghai', others: doubled },
      ),
    ).toThrow('不唯一')
  })
})

describe("the old analyses' shapes", () => {
  const statuses = (values: string[]): BusinessRecord[] =>
    values.map((customer, index) => row(`r${index}`, customer, 'CNY', '1'))
  it('counts rows with no group under 未填写, and never does that for a sum', () => {
    const rows = statuses(['甲', '', '甲', '—'])
    expect(
      calculateRows(recordsDataset(source, rows), {
        collection: 'sales-orders',
        operation: 'count',
        groupBy: 'customer',
        missingGroup: 'label',
      }).groups.map(g => [g.group, g.value]),
    ).toEqual([
      ['（未填写）', '2'],
      ['甲', '2'],
    ])
    expect(() =>
      calculateRows(recordsDataset(source, rows), {
        collection: 'sales-orders',
        operation: 'sum',
        groupBy: 'customer',
        measure: 'amount',
        unitField: 'currency',
        missingGroup: 'label',
      }),
    ).toThrow('混在一起')
  })
  it('sorts by value and merges everything after the top N counts into 其他', () => {
    const rows = statuses(['甲', '乙', '乙', '丙', '丙', '丙', '丁'])
    const result = calculateRows(recordsDataset(source, rows), {
      collection: 'sales-orders',
      operation: 'count',
      groupBy: 'customer',
      sort: 'value-desc',
      top: 2,
    })
    expect(result.groups.map(g => [g.group, g.value])).toEqual([
      ['丙', '3'],
      ['乙', '2'],
      ['其他（2 个分组）', '2'],
    ])
    expect(result.groups[2]).toMatchObject({ mergedGroups: 2, count: 2 })
    expect(() =>
      calculateRows(recordsDataset(source, rows), {
        collection: 'sales-orders',
        operation: 'sum',
        groupBy: 'customer',
        measure: 'amount',
        unitField: 'currency',
        sort: 'value-desc',
        top: 2,
      }),
    ).toThrow('只用于记录数')
  })
})

describe('datasets a run fetched', () => {
  const orders = jsonDataset('orders', [
    { id: 'o1', customer: { id: 'c1', name: '甲' }, currency: 'CNY', adjusted_total: 32000, items: [{ id: 'i1' }] },
    { id: 'o2', customer: { id: 'c2', name: '乙' }, currency: 'CNY', adjusted_total: '85680.5', shipped_at: null },
  ])
  const shipments = jsonDataset('shipments', [
    { id: 's1', sales_order_id: 'o1', status: 'shipped' },
    { id: 's2', sales_order_id: 'o2', status: 'draft' },
  ])
  it('reads nested fields as a.b, leaves lists out, and keeps each row id', () => {
    expect(orders.rows[0]).toEqual({
      id: 'o1',
      values: { id: 'o1', 'customer.id': 'c1', 'customer.name': '甲', currency: 'CNY', adjusted_total: '32000' },
    })
    expect(orders.rows[1]!.values.shipped_at).toBe('')
    expect(jsonDataset('lines', [{ sku: 'a' }]).rows[0]!.id).toBe('#1')
    const summed = calculateRows(orders, {
      collection: 'orders',
      operation: 'sum',
      groupBy: 'customer.name',
      measure: 'adjusted_total',
      unitField: 'currency',
    })
    expect(summed.groups.map(g => [g.group, g.value])).toEqual([
      ['甲', '32000'],
      ['乙', '85680.5'],
    ])
  })
  it('joins one dataset to another by name, and still reads its own dotted fields as its own', () => {
    const others = new Map([
      ['orders', orders],
      ['shipments', shipments],
    ])
    const shipped = calculateRows(
      shipments,
      {
        collection: 'shipments',
        operation: 'count',
        groupBy: 'orders.customer.name',
        where: [{ field: 'status', op: 'eq', value: 'shipped' }],
        join: { collection: 'orders', localField: 'sales_order_id' },
      },
      { timeZone: 'Asia/Shanghai', others },
    )
    expect(shipped.groups.map(g => [g.group, g.value])).toEqual([['甲', '1']])
    expect(() => calculateRows(shipments, { collection: 'shipments', operation: 'count', groupBy: 'carrier' })).toThrow(
      '不在数据集',
    )
  })
})
