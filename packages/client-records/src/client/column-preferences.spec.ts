// @vitest-environment jsdom

import type { ConnectionSummary } from '@oryh/ai-client-core'
import { recordDefaultColumns } from '@oryh/ai-client-records'
import { columnPreferenceScope, createColumnPreference, useColumnPreference } from '@oryh/dsh-client-frame/client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'

// The frame re-exports Fluent, which does not load under Node; nothing here renders it.
vi.mock('@fluentui/react-components', () => ({}))

import { recordCatalog } from './catalog.js'

const connection = {
  origin: 'https://example.test',
  identity: { tenant: { id: 'tenant-a' }, user: { id: 'user-a' } },
} as ConnectionSummary
const movements = recordCatalog('inventory-item-details')
beforeEach(() => {
  localStorage.clear()
})
it('restores Chat column changes after the list unmounts and remounts', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  let preference!: ReturnType<typeof useColumnPreference>
  function View() {
    preference = useColumnPreference(connection, 'inventory-item-details', movements)
    return createElement('div', null, preference[0].join(','))
  }
  let root = createRoot(container)
  act(() => root.render(createElement(View)))
  act(() => preference[1](['reason', 'created_at']))
  act(() => root.unmount())
  root = createRoot(container)
  act(() => root.render(createElement(View)))
  expect(container.textContent).toBe('reason,created_at')
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
it('isolates preferences by server, tenant, user and list, but survives reconnect', () => {
  const scope = columnPreferenceScope(connection)
  createColumnPreference(scope, 'inventory-item-details', movements).set(['reason'])
  for (const other of [
    { ...connection, origin: 'https://other.test' },
    { ...connection, identity: { ...connection.identity, tenant: { ...connection.identity.tenant, id: 'tenant-b' } } },
    { ...connection, identity: { ...connection.identity, user: { ...connection.identity.user, id: 'user-b' } } },
  ])
    expect(
      createColumnPreference(columnPreferenceScope(other), 'inventory-item-details', movements).getSnapshot(),
    ).toEqual(recordDefaultColumns['inventory-item-details'])
  expect(columnPreferenceScope({ ...connection, id: 'reconnected' as ConnectionSummary['id'] })).toBe(scope)
  expect(createColumnPreference(scope, 'shipments', recordCatalog('shipments')).getSnapshot()).toEqual(
    recordDefaultColumns.shipments,
  )
  expect(createColumnPreference(scope, 'inventory-item-details', movements).getSnapshot()).toEqual(['reason'])
})
it('validates hydrated JSON and drops obsolete fields', () => {
  const key = 'oryh.columns.v1:test:inventory-item-details'
  for (const value of [null, {}, [], ['removed', '__proto__']]) {
    localStorage.setItem(key, JSON.stringify(value))
    expect(createColumnPreference('test', 'inventory-item-details', movements).getSnapshot()).toEqual(
      recordDefaultColumns['inventory-item-details'],
    )
  }
  localStorage.setItem(key, JSON.stringify(['reason', 'removed', 'reason', 7]))
  expect(createColumnPreference('test', 'inventory-item-details', movements).getSnapshot()).toEqual(['reason'])
})
it('persists changes and resets independently for every record list', () => {
  for (const kind of Object.keys(recordDefaultColumns) as (keyof typeof recordDefaultColumns)[]) {
    createColumnPreference('test', kind, recordCatalog(kind)).set(['id'])
    expect(createColumnPreference('test', kind, recordCatalog(kind)).getSnapshot()).toEqual(['id'])
    createColumnPreference('test', kind, recordCatalog(kind)).set(recordDefaultColumns[kind])
    expect(createColumnPreference('test', kind, recordCatalog(kind)).getSnapshot()).toEqual(recordDefaultColumns[kind])
  }
})
