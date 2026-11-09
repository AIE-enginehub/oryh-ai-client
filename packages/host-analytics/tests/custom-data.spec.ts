import { expect, it } from 'vitest'
import { CustomDataRun } from '../src/custom-data.js'
import { customDefinitionSchema } from '../src/custom-model.js'
import type { ActiveRun } from '../src/custom-service.js'

const definition = customDefinitionSchema.parse({
  title: '订单统计',
  html: '<main><span data-oryh-field="total"></span></main>',
  css: '',
  script: '',
  fixedText: '',
  task: {
    instruction: '统计当前销售订单并说明风险，不得编造事实。',
    timeZone: 'Asia/Shanghai',
    sources: [
      {
        collection: 'sales-orders',
        filters: {},
        display: { columns: [{ field: 'order_no', label: '订单号' }] },
      },
    ],
    contract: { fields: [{ name: 'total', type: 'number', required: true }] },
  },
})

/** One run as the page service hands it to the data engine. */
function fixture() {
  const active: ActiveRun = {
    pageId: 'page-1',
    parent: { sessionId: 's', connectionId: 'c' } as never,
    scopeKey: 'workspace',
    definition,
    run: {
      id: 'run-1',
      version: 1,
      status: 'running',
      startedAt: '2026-10-22T00:00:00Z',
      task: 'task',
    },
    datasets: new Map(),
    loading: new Set(),
    requests: 0,
    step: '',
    reading: 0,
    serial: 0,
    cancel: new AbortController(),
  }
  const records = {
    collectionList: async ({ page }: { page: number }) => ({
      rows: [
        {
          id: page === 1 ? 'a' : 'b',
          title: page === 1 ? 'A' : 'B',
          status: '',
          summary: '',
          date: '',
          fields: [
            { field: 'id', label: '编号', value: page === 1 ? 'a' : 'b' },
            { field: 'order_no', label: '订单号', value: page === 1 ? 'SO-A' : 'SO-B' },
          ],
        },
      ],
      page,
      pages: 2,
      total: 2,
      fetchedAt: '2026-10-22T00:00:00Z',
    }),
  }
  const data = new CustomDataRun({
    records: records as never,
    runOf: () => active,
    scope: async () => ({ key: 'workspace' }),
    step: () => {},
    runText: (_active, zh) => zh,
  })
  return { active, data }
}

it('reads a declared source in full and pages it out to the model', async () => {
  const { active, data } = fixture()
  const first = JSON.parse(await data.read('child', 'sales-orders', 0, 1))
  expect(first).toMatchObject({ dataset: 'sales-orders', total: 2, offset: 0 })
  expect(first.rows.map((row: { id: string }) => row.id)).toEqual(['a'])
  expect(first.next).toBe(1)
  expect(active.requests).toBe(2)
  const second = JSON.parse(await data.read('child', 'sales-orders', 1))
  expect(second.rows.map((row: { id: string }) => row.id)).toEqual(['b'])
  expect(second.next).toBeUndefined()
})

it('validates a published result against the page contract', async () => {
  const { active, data } = fixture()
  await data.read('child', 'sales-orders')
  expect(data.publish('child', JSON.stringify({ total: 2 }))).toContain('仍需')
  expect(active.result).toEqual({ total: 2 })
  expect(() => data.publish('child', JSON.stringify({ total: 'two' }))).toThrow()
})
