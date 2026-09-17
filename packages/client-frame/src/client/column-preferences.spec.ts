// @vitest-environment jsdom
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it } from 'vitest'
import {
  type ColumnCatalog,
  columnPreference,
  columnPreferenceScope,
  useColumnPreference,
} from './column-preferences.js'

const connection = {
  id: 'c',
  origin: 'https://oryh.example.test',
  identity: { tenant: { id: 't' }, user: { id: 'u' } },
} as unknown as ConnectionSummary
/** Built afresh on every call, as the page plugins build theirs on every render. */
const catalog = (): ColumnCatalog => ({
  allowed: { reason: '变动原因', quantity: '现存数量变动', product: '产品编码' },
  defaults: ['reason', 'quantity', 'product'],
})

/** A list that shows its columns in order, as the record and project lists do. */
function List(): ReactNode {
  const [columns] = useColumnPreference(connection, 'inventory-item-details', catalog())
  return h('p', null, columns.join(','))
}

beforeEach(() => localStorage.clear())

it("shows a column change the agent's bridge makes while the list is open, without waiting for another render", async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(h(List)))
  expect(container.textContent).toBe('reason,quantity,product')

  // The bridge reaches the store on its own, with its own catalog object, as RecordBridge does.
  await act(async () => {
    columnPreference(columnPreferenceScope(connection), 'inventory-item-details', catalog()).set([
      'product',
      'reason',
      'quantity',
    ])
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  expect(container.textContent).toBe('product,reason,quantity')
  await act(async () => root.unmount())
})
