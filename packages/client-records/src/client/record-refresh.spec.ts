// @vitest-environment jsdom
import { fakeFace, wordsOf } from '@oryh/ai-client-kit/testing'
import type { BusinessRecord, RecordChild } from '@oryh/ai-client-records'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CollectionPanel } from './collection.js'
import { english } from './en.js'
import { RecordPanel } from './records.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})
const panels = ['collection', 'built-in'] as const
const record = (title: string): BusinessRecord => ({
  id: 'o1',
  title,
  summary: '',
  date: '',
  fields: [{ field: 'order_no', label: '订单号', value: title }],
})
const before = record('SO-1')
const after = record('SO-1 submitted')

async function setup(panel: (typeof panels)[number]) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { face, state } = fakeFace({
    frame: { t: ((key: string) => (key === 'interfaceLanguage' ? 'en' : key)) as never },
  })
  const view = {
    id: 'refresh-orders',
    label: 'Draft orders',
    collection: 'sales-orders',
    filters: { status: 'draft' },
    display: { columns: [{ field: 'order_no', label: '订单号' }] },
  }
  const data: { rows: BusinessRecord[]; children: RecordChild[] } = {
    rows: [before],
    children: [
      {
        key: 'items',
        label: '明细',
        columns: [{ field: 'quantity', label: '数量' }],
        rows: [{ id: 'line', quantity: '2' }],
      },
    ],
  }
  const list = vi.fn(async () => ({ rows: data.rows, total: data.rows.length, page: 1, pages: 1, fetchedAt: '' }))
  const get = vi.fn(async () => after)
  const api = {
    collectionList: list,
    recordList: list,
    collectionGet: get,
    recordGet: get,
    recordFilterFields: vi.fn(async () => []),
    recordDetail: vi.fn(async () => ({ children: data.children })),
  }
  const onContext = vi.fn(),
    node = document.createElement('div'),
    root = createRoot(node)
  cleanup.push(() => act(async () => root.unmount()))
  const props = {
    api: api as never,
    face,
    t: wordsOf(english) as never,
    columns: ['order_no'],
    onColumns: vi.fn(),
    onContext,
  }
  await act(async () => {
    root.render(
      panel === 'collection'
        ? h(CollectionPanel, { ...props, view })
        : h(RecordPanel, { ...props, kind: 'sales-orders', view }),
    )
  })
  await act(async () => node.querySelector<HTMLButtonElement>('.record-link')!.click())
  const refresh = () => act(async () => state({ serverChange: { id: 'write-1', at: Date.now() } }))
  return { api, data, get, list, node, onContext, refresh }
}

it.each(panels)('%s: refreshes child rows after a Chat write, including added and deleted lines', async panel => {
  const f = await setup(panel)
  expect(f.node.querySelector('tbody')?.textContent).toBe('2')
  f.data.rows = [after]
  f.data.children = [
    {
      ...f.data.children[0]!,
      rows: [
        { id: 'new-line', quantity: '7' },
        { id: 'another', quantity: '8' },
      ],
    },
  ]
  await f.refresh()
  expect(f.node.querySelector('tbody')?.textContent).toBe('78')
  expect(f.api.recordDetail).toHaveBeenCalledTimes(2)
  expect(f.node.textContent).toContain(after.title)
  expect(f.get).not.toHaveBeenCalled()
})

it.each(panels)('%s: reloads an open record by id when a write moves it out of the list', async panel => {
  const f = await setup(panel)
  f.data.rows = []
  await f.refresh()
  expect(f.get).toHaveBeenCalledTimes(1)
  expect(f.node.textContent).toContain(after.title)
  expect(f.onContext.mock.lastCall?.[0].title).toBe(after.title)
})

it.each(panels)('%s: clears a stale detail and Chat context when the record is no longer readable', async panel => {
  const f = await setup(panel)
  f.data.rows = []
  f.get.mockRejectedValue(new Error('Record deleted or access denied'))
  await f.refresh()
  expect(f.node.textContent).not.toContain(before.title)
  expect(f.node.textContent).toContain('Record deleted or access denied')
  expect(f.onContext.mock.lastCall?.[0].key).toMatch(/:list$/)
  expect(f.onContext.mock.lastCall?.[0].content).not.toContain(before.title)
})

it.each(panels)('%s: a late refresh cannot reopen a detail after the user returns to the list', async panel => {
  const f = await setup(panel)
  let finish!: (value: BusinessRecord) => void
  f.get.mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    }),
  )
  f.data.rows = []
  await f.refresh()
  expect(f.get).toHaveBeenCalledTimes(1)
  const back = [...f.node.querySelectorAll<HTMLButtonElement>('button')].find(
    button => button.textContent === 'listBack',
  )!
  await act(async () => back.click())
  await act(async () => finish(after))
  expect(f.node.textContent).not.toContain(after.title)
  expect(f.onContext.mock.lastCall?.[0].key).toMatch(/:list$/)
})
