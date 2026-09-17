// @vitest-environment jsdom

import { fakePane, formatDisplayValue, PaneValueContext } from '@oryh/dsh-client-frame/client'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RecordsApiContext } from './api.js'
import { RecordPanel } from './records.js'

vi.mock('@oryh/dsh-client-frame/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@oryh/dsh-client-frame/client')>()
  return { ...actual, useText: () => (key: keyof typeof actual.dictionaries) => actual.dictionaries[key] }
})
vi.mock('./product-picker.js', () => ({ ProductPicker: () => h('button', null, '选择产品') }))
vi.mock('@fluentui/react-components', () => ({
  Spinner: () => null,
  MessageBar: ({ children }: any) => h('div', { role: 'alert' }, children),
  MessageBarBody: ({ children }: any) => h('span', null, children),
  Button: ({ appearance, size, icon, children, ...props }: any) => h('button', props, children),
  Field: ({ label, children }: any) => h('label', null, label, children),
  Input: ({ onChange, ...props }: any) =>
    h('input', { ...props, onChange: (e: any) => onChange?.(e, { value: e.target.value }) }),
}))
it('updates ledger columns and page context without fetching again, and retains record access', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const recordList = vi.fn(async () => ({
    rows: [
      {
        id: 'r',
        title: 'issued',
        fields: [
          { label: '产品编码', value: 'P-1' },
          { label: '现存数量变动', value: '-1' },
          { label: '创建时间', value: '2026-09-01T08:00:00Z' },
        ],
      },
    ],
    page: 1,
    pages: 1,
    total: 1,
    fetchedAt: '',
  }))
  const api = {
      recordList,
      recordFilterFields: vi.fn(async () => [
        { name: 'inventory_item_id', type: 'string' },
        { name: 'reason', type: 'string' },
        { name: 'include_archived_items', type: 'boolean' },
      ]),
    },
    onContext = vi.fn(),
    onColumns = vi.fn(),
    node = document.createElement('div'),
    root = createRoot(node)
  const render = (columns: string[]) =>
    root.render(
      h(
        RecordsApiContext.Provider,
        { value: api as never },
        h(RecordPanel, { kind: 'inventory-item-details', connectionId: 'c', columns, onColumns, onContext }),
      ),
    )
  try {
    await act(async () => render(['quantity_on_hand_diff']))
    await act(async () => render(['product_code', 'created_at', 'quantity_on_hand_diff']))
    expect(Array.from(node.querySelectorAll('th:not(.row-open-cell)')).map(n => n.textContent)).toEqual([
      '产品编码',
      '创建时间',
      '现存数量变动',
    ])
    // Timestamps read as the rest of the workbench writes time, not as the raw ISO string.
    expect(node.querySelector('tbody')?.textContent).toContain(`P-1${formatDisplayValue('2026-09-01T08:00:00Z')}-1`)
    expect(recordList).toHaveBeenCalledTimes(1)
    expect(onContext.mock.lastCall?.[0].columns).toEqual(['product_code', 'created_at', 'quantity_on_hand_diff'])
    await act(async () => node.querySelector<HTMLButtonElement>('.record-link')!.click())
    expect(node.textContent).toContain('记录信息')
    expect(onContext.mock.lastCall?.[0].key).toBe('inventory-item-details:r')
  } finally {
    await act(async () => root.unmount())
  }
})

it('adds a query control without querying and submits the product through the shared Remote', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const recordList = vi.fn(async () => ({ rows: [], page: 1, pages: 1, total: 0, fetchedAt: '' })),
    api = {
      recordList,
      recordFilterFields: vi.fn(async () => [
        { name: 'inventory_item_id', type: 'string' },
        { name: 'reason', type: 'string' },
        { name: 'include_archived_items', type: 'boolean' },
      ]),
    },
    onContext = vi.fn()
  const node = document.createElement('div'),
    root = createRoot(node),
    pane = fakePane()
  const render = () =>
    root.render(
      h(
        PaneValueContext.Provider,
        { value: pane.value },
        h(
          RecordsApiContext.Provider,
          { value: api as never },
          h(RecordPanel, {
            kind: 'inventory-item-details',
            connectionId: 'c',
            columns: ['id'],
            onColumns: () => {},
            onContext,
          }),
        ),
      ),
    )
  const command = (id: string, payload: Record<string, unknown>) =>
    act(async () => {
      pane.command({
        lane: 'navigation',
        id,
        page: 'inventory-item-details',
        payload: { target: 'filters', page: 'inventory-item-details', ...payload } as never,
      })
    })
  try {
    await act(async () => render())
    await command('add', { queryFields: ['product_code'] })
    expect(node.textContent).toContain('产品（多选）')
    expect(recordList).toHaveBeenCalledTimes(1)
    expect(pane.acked()).toEqual(['add'])
    await command('query', { queryFields: ['product_code'], products: [{ id: 'p', code: 'PT-HEAD', name: '打印头' }] })
    expect(recordList.mock.lastCall?.[0]).toMatchObject({ productIds: ['p'], page: 1 })
    expect(onContext.mock.lastCall?.[0].productIds).toEqual(['p'])
    await act(async () =>
      Array.from(node.querySelectorAll('button'))
        .find(b => b.textContent === '清空条件')!
        .click(),
    )
    expect(recordList.mock.lastCall?.[0]).toMatchObject({ productIds: [], query: '', page: 1 })
  } finally {
    await act(async () => root.unmount())
  }
})

it('restores Chat query fields and products on remount, refetches data, and isolates identities', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  const { PreferenceScope } = await import('@oryh/dsh-client-frame/client')
  const recordList = vi.fn(async () => ({ rows: [], page: 1, pages: 1, total: 0, fetchedAt: '' })),
    onContext = vi.fn()
  const node = document.createElement('div')
  let root = createRoot(node)
  const pane = fakePane()
  const render = (scope: string) =>
    root.render(
      h(
        PaneValueContext.Provider,
        { value: pane.value },
        h(
          PreferenceScope.Provider,
          { value: scope },
          h(
            RecordsApiContext.Provider,
            {
              value: {
                recordList,
                recordFilterFields: vi.fn(async () => [
                  { name: 'inventory_item_id', type: 'string' },
                  { name: 'reason', type: 'string' },
                  { name: 'include_archived_items', type: 'boolean' },
                ]),
              } as never,
            },
            h(RecordPanel, {
              kind: 'inventory-item-details',
              connectionId: scope,
              columns: ['id'],
              onColumns: () => {},
              onContext,
            }),
          ),
        ),
      ),
    )
  await act(async () => render('tenant-a:user-a'))
  await act(async () => {
    pane.command({
      lane: 'navigation',
      id: 'query',
      page: 'inventory-item-details',
      payload: {
        target: 'filters',
        page: 'inventory-item-details',
        queryFields: ['product_code'],
        products: [{ id: 'p', code: 'PT-HEAD', name: '打印头' }],
      },
    })
  })
  // Acknowledged, the Host withdraws the command; what survives a remount is the page's own preference.
  expect(pane.acked()).toEqual(['query'])
  await act(async () => {
    pane.publish({ commands: [] })
  })
  await act(async () => root.unmount())
  root = createRoot(node)
  await act(async () => render('tenant-a:user-a'))
  expect(node.textContent).toContain('产品（多选）')
  expect(recordList.mock.lastCall?.[0]).toMatchObject({ productIds: ['p'] })
  expect(onContext.mock.lastCall?.[0].queryFields).toEqual(['product_code'])
  await act(async () => render('tenant-b:user-a'))
  expect(node.textContent).not.toContain('产品（多选）')
  expect(recordList.mock.lastCall?.[0]).toMatchObject({ productIds: [] })
  await act(async () => render('tenant-a:user-a'))
  await act(async () =>
    Array.from(node.querySelectorAll('button'))
      .find(b => b.textContent === '清空条件')!
      .click(),
  )
  await act(async () => root.unmount())
  root = createRoot(node)
  await act(async () => render('tenant-a:user-a'))
  expect(recordList.mock.lastCall?.[0]).toMatchObject({ productIds: [] })
  await act(async () => root.unmount())
})

it('offers only query fields the endpoint declares, and sends their values to the server', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  const recordList = vi.fn(async () => ({ rows: [], page: 1, pages: 1, total: 0, fetchedAt: '' })),
    onContext = vi.fn()
  // What GET /inventory-item-details declares on a real deployment: no effective-date parameter.
  const recordFilterFields = vi.fn(async () => [
    { name: 'inventory_item_id', type: 'string' },
    { name: 'reason', type: 'string' },
    { name: 'include_archived_items', type: 'boolean' },
  ])
  // One stable Remote, as useOryhRemote gives the page: a fresh object per render would re-run every query.
  const api = { recordList, recordFilterFields }
  const node = document.createElement('div'),
    root = createRoot(node),
    pane = fakePane()
  const render = () =>
    root.render(
      h(
        PaneValueContext.Provider,
        { value: pane.value },
        h(
          RecordsApiContext.Provider,
          { value: api as never },
          h(RecordPanel, {
            kind: 'inventory-item-details',
            connectionId: 'c',
            columns: ['id'],
            onColumns: () => {},
            onContext,
          }),
        ),
      ),
    )
  try {
    await act(async () => render())
    const picker = () =>
      Array.from(node.querySelectorAll('details')).find(d => d.querySelector('summary')?.textContent === '查询字段')
    const options = Array.from(picker()!.querySelectorAll('label')).map(l => l.textContent)
    // Declared fields are offered under their column names; the search box's own field is not repeated.
    expect(options).toEqual(['产品', '变动原因', 'include_archived_items'])
    // 生效时间 is a column, not a query parameter, so it is not offered as a query field.
    expect(options).not.toContain('生效时间')

    await act(async () => {
      pane.command({
        lane: 'navigation',
        id: 'q',
        page: 'inventory-item-details',
        payload: {
          target: 'filters',
          page: 'inventory-item-details',
          queryFields: ['reason'],
          queryValues: { reason: 'sale' },
        },
      })
    })
    expect(recordList.mock.lastCall?.[0]).toMatchObject({
      kind: 'inventory-item-details',
      filters: { reason: 'sale' },
      page: 1,
    })
    expect(onContext.mock.lastCall?.[0]).toMatchObject({ queryFields: ['reason'], queryValues: { reason: 'sale' } })

    // One request per applied command, and never one sent before the values are in place: an unfiltered
    // read here would be a wasted call to ORYH, and for a product query up to a hundred of them.
    expect(recordList.mock.calls.map(c => c[0].filters)).toEqual([undefined, { reason: 'sale' }])

    // A command for another list is not this list's to apply.
    const calls = recordList.mock.calls.length
    await act(async () => {
      pane.command({
        lane: 'navigation',
        id: 'other',
        page: 'shipments',
        payload: {
          target: 'filters',
          page: 'shipments',
          queryFields: ['direction'],
          queryValues: { direction: 'inbound' },
        },
      })
    })
    expect(recordList.mock.calls.length).toBe(calls)
    expect(pane.acked()).not.toContain('other')
  } finally {
    await act(async () => root.unmount())
  }
})
