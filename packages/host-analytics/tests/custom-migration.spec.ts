import { describe, expect, it } from 'vitest'
import { migrateAnalysis, migratedTitle } from '../src/custom-migration.js'
import { type AnalysisDocument, validateDefinition } from '../src/model.js'

function analysis(changes: Record<string, unknown>): AnalysisDocument {
  return {
    id: 'old-1',
    version: 3,
    updatedAt: '2026-09-01T00:00:00Z',
    definition: validateDefinition({
      title: '客户订单金额',
      kind: 'chart',
      source: 'sales-orders',
      query: '',
      filters: [],
      productIds: [],
      groupBy: 'customer_name_snapshot',
      measure: 'count',
      display: 'bar',
      sort: 'label',
      topN: 0,
      summary: '',
      findings: '',
      nextSteps: '',
      ...changes,
    }),
  }
}
const calculation = (instruction: string) =>
  JSON.parse(instruction.slice(instruction.indexOf('参数严格为：') + 6, instruction.indexOf('。把返回的')))

describe('migrating an old analysis', () => {
  it('keeps a count, its order, its top N and the query, and draws it the way the old one did', () => {
    const result = migrateAnalysis(
      analysis({ sort: 'value-desc', topN: 5, query: '医院', filters: [{ field: 'status', value: 'confirmed' }] }),
      '客户订单金额',
    )
    if ('error' in result) throw new Error(result.error)
    const { task, html } = result.definition
    expect(task.sources).toEqual([
      {
        collection: 'sales-orders',
        filters: { status: 'confirmed', keyword: '医院' },
        display: { columns: [{ field: 'customer_name_snapshot', label: '客户' }] },
      },
    ])
    expect(calculation(task.instruction)).toEqual({
      collection: 'sales-orders',
      operation: 'count',
      groupBy: 'customer_name_snapshot',
      missingGroup: 'label',
      sort: 'value-desc',
      top: 5,
    })
    expect(html).toContain('data-oryh-chart="bar"')
    expect(html).toContain('前 5 项')
    // A count's value is its record count: one column, not two.
    expect(html.match(/记录数/g)).toHaveLength(2)
    expect(html).not.toContain('data-oryh-field="count"')
    expect(result.notes).toEqual([])
  })

  it('sums by currency, the grouping the old analysis required, so nothing is mixed', () => {
    const result = migrateAnalysis(
      analysis({ groupBy: 'currency', measure: 'total_amount', display: 'table' }),
      '客户订单金额',
    )
    if ('error' in result) throw new Error(result.error)
    expect(calculation(result.definition.task.instruction)).toEqual({
      collection: 'sales-orders',
      operation: 'sum',
      groupBy: 'currency',
      measure: 'total_amount',
      unitField: 'currency',
      sort: 'label',
    })
    expect(result.definition.html).not.toContain('data-oryh-chart')
    expect(result.notes).toEqual([])
  })

  it('reaches a stock movement’s product through its position, and reads positions only when it must', () => {
    const byProduct = migrateAnalysis(
      analysis({ source: 'inventory-item-details', groupBy: 'product_code' }),
      '库存变动',
    )
    if ('error' in byProduct) throw new Error(byProduct.error)
    expect(byProduct.definition.task.sources.map(source => source.collection)).toEqual([
      'inventory-item-details',
      'inventory-items',
    ])
    expect(calculation(byProduct.definition.task.instruction)).toMatchObject({
      groupBy: 'inventory-items.product_code',
      join: { collection: 'inventory-items', localField: 'inventory_item_id' },
    })
    const byPosition = migrateAnalysis(
      analysis({ source: 'inventory-item-details', groupBy: 'inventory_item_id', measure: 'quantity_on_hand_diff' }),
      '库存变动',
    )
    if ('error' in byPosition) throw new Error(byPosition.error)
    expect(byPosition.definition.task.sources.map(source => source.collection)).toEqual(['inventory-item-details'])
    expect(calculation(byPosition.definition.task.instruction)).toMatchObject({
      groupBy: 'inventory_item_id',
      unitField: 'inventory_item_id',
    })
  })

  it('carries report sections over word for word and in order, as text that cannot run', () => {
    const result = migrateAnalysis(
      analysis({
        kind: 'report',
        sections: [
          { id: 'summary', title: '摘要', body: '第一段\n<script>alert(1)</script>' },
          { id: 'findings', title: '观察与结论', body: '' },
          { id: 'nextSteps', title: '后续行动', body: '跟进 A & B' },
          { id: 'custom-1', title: '附录', body: '手写的内容' },
        ],
        summary: '第一段\n<script>alert(1)</script>',
        findings: '',
        nextSteps: '跟进 A & B',
      }),
      '客户订单金额',
    )
    if ('error' in result) throw new Error(result.error)
    const { html } = result.definition
    expect(html.indexOf('摘要')).toBeLessThan(html.indexOf('附录'))
    expect(html).toContain('第一段\n&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('跟进 A &amp; B')
    expect(html).not.toContain('<script>')
  })

  it('refuses what it cannot carry faithfully, with the reason', () => {
    expect(
      migrateAnalysis(analysis({ source: 'inventory-item-details', groupBy: 'reason', productIds: ['p1', 'p2'] }), 'x'),
    ).toMatchObject({ error: expect.stringContaining('产品多选') })
  })

  it('fits a title into a menu entry and never takes one already used', () => {
    expect(migratedTitle('客户订单金额', new Set())).toBe('客户订单金额')
    expect(migratedTitle('客户订单金额', new Set(['客户订单金额']))).toBe('客户订单金额（2）')
    const long = '二零二六年第三季度全部客户销售订单金额分布与趋势分析报告'
    expect(migratedTitle(long, new Set())).toHaveLength(24)
    expect(migratedTitle(long, new Set()).endsWith('…')).toBe(true)
  })
})
