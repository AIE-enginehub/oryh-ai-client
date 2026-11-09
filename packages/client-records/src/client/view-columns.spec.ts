// @vitest-environment jsdom

import { columnPreferenceScope, createColumnPreference } from '@oryh/ai-client-kit'
import { fakeFace } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { recordCatalog, recordViewKey } from './catalog.js'
import { RecordBridge } from './index.js'

it('applies a column command only to its current saved view and preserves the built-in list across reload', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const connection = {
    id: 'c',
    origin: 'https://example.invalid',
    identity: { tenant: { id: 't' }, user: { id: 'u' } },
  } as never
  const pane = fakeFace({ connection })
  const kind = 'inventory-item-details'
  const view = { id: 'view-a', label: '入库', kind, filters: { reason: 'received' } } as const
  pane.local.setContext({ key: `${kind}:list`, title: '入库', detail: '', scope: '', view })
  const scope = columnPreferenceScope(connection)
  // What is kept for a list, read afresh from where it is stored, as a reload would.
  const kept = (list: string) => createColumnPreference(scope, list, recordCatalog(kind)).getSnapshot()
  // And what the bridge and the list share while the page is open.
  const live = () => pane.face.prefs.get(`oryh.columns.v1:${scope}:${recordViewKey(kind, view.id)}`)
  const original = [...kept(kind)]
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(h(RecordBridge, { face: pane.face })))
    await act(async () =>
      pane.command({
        lane: 'navigation',
        id: 'a',
        page: kind,
        payload: {
          target: 'columns',
          page: kind,
          userViewId: view.id,
          columns: ['reason', 'product_code'],
        },
      }),
    )
    expect(live()).toEqual(['reason', 'product_code'])
    expect(pane.acked()).toContain('a')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(kept(kind)).toEqual(original)
    expect(createColumnPreference(scope, recordViewKey(kind, view.id), recordCatalog(kind)).getSnapshot()).toEqual([
      'reason',
      'product_code',
    ])
    await act(async () => {
      pane.local.setContext({ key: `${kind}:list`, title: '库存流水', detail: '', scope: '' })
      pane.command({
        lane: 'navigation',
        id: 'late',
        page: kind,
        payload: {
          target: 'columns',
          page: kind,
          userViewId: view.id,
          columns: ['id'],
        },
      })
    })
    expect(pane.acked()).not.toContain('late')
    expect(live()).toEqual(['reason', 'product_code'])
    expect(kept(kind)).toEqual(original)
  } finally {
    await act(async () => root.unmount())
  }
})

it('names a row by its title, and adds to one its neighbours share or that is only an id', async () => {
  const { rowName, sharedTitles } = await import('./catalog.js')
  const rows = [
    { id: 'a1', title: 'import_initial' },
    { id: 'a2', title: 'import_initial' },
    { id: 'a3', title: 'SO-000017' },
  ]
  const shared = sharedTitles(rows)
  // Many rows of one reason: the next thing the row shows is added.
  expect(rowName(rows[0]!, ['import_initial', '25cm 碟', '0'], shared)).toBe('import_initial · 25cm 碟')
  // A title of its own is enough.
  expect(rowName(rows[2]!, ['SO-000017', '草稿'], shared)).toBe('SO-000017')
  // No title field, so the title is the id: what the row shows names it instead.
  expect(rowName({ id: 'a1', title: 'a1' }, ['SO-000017', '草稿'], shared)).toBe('SO-000017 · 草稿')
  // Nothing shown says anything: the id is all there is.
  expect(rowName({ id: 'a1', title: 'a1' }, ['—', ''], shared)).toBe('a1')
})

it('starts a menu entry over a built-in list with the columns it was made with, in their order', () => {
  const made = {
    display: {
      columns: [
        { field: 'status' },
        { field: 'logistics_tracking_no' },
        { field: 'source_report' },
        { field: 'order_no' },
      ],
    },
  }
  // A column the list cannot show is left out rather than replaced by one nobody asked for.
  expect(recordCatalog('sales-orders', made).defaults).toEqual(['status', 'logistics_tracking_no', 'order_no'])
  expect(recordCatalog('sales-orders', { display: { columns: [] } }).defaults).toEqual(
    recordCatalog('sales-orders').defaults,
  )
})
