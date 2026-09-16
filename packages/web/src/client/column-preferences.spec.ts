// @vitest-environment jsdom
import {beforeEach, expect, it, vi} from 'vitest'
import {act, createElement} from 'react'
import {createRoot} from 'react-dom/client'
import type {ConnectionSummary} from '@oryh/ai-client-core'
import {recordDefaultColumns} from '@oryh/ai-client-records'
import {columnPreferenceScope, createColumnPreference, useColumnPreferences} from './column-preferences.js'

const connection = {origin:'https://example.test', identity:{tenant:{id:'tenant-a'},user:{id:'user-a'}}} as ConnectionSummary
beforeEach(() => {localStorage.clear()})
it('restores Chat column changes after the workbench unmounts and remounts', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  let preferences!: ReturnType<typeof useColumnPreferences>
  function View() {
    preferences = useColumnPreferences(connection)
    return createElement('div', null, preferences.projectColumns.join(','))
  }
  let root = createRoot(container)
  act(() => root.render(createElement(View)))
  act(() => preferences.setProjectColumns(['name','createdAt','client']))
  act(() => preferences.setRecordColumns('inventory-item-details',['reason','created_at']))
  act(() => root.unmount())
  root = createRoot(container)
  act(() => root.render(createElement(View)))
  expect(container.textContent).toBe('name,createdAt,client')
  expect(preferences.recordViewColumns['inventory-item-details']).toEqual(['reason','created_at'])
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
it('isolates preferences by server, tenant, user and list, but survives reconnect', () => {
  const scope = columnPreferenceScope(connection)
  createColumnPreference(scope,'list-projects').set(['name','createdAt'])
  for (const other of [
    {...connection,origin:'https://other.test'},
    {...connection,identity:{...connection.identity,tenant:{...connection.identity.tenant,id:'tenant-b'}}},
    {...connection,identity:{...connection.identity,user:{...connection.identity.user,id:'user-b'}}},
  ]) expect(createColumnPreference(columnPreferenceScope(other),'list-projects').getSnapshot()).not.toContain('createdAt')
  expect(columnPreferenceScope({...connection,id:'reconnected' as ConnectionSummary['id']})).toBe(scope)
  expect(createColumnPreference(scope,'inventory-item-details').getSnapshot()).toEqual(recordDefaultColumns['inventory-item-details'])
  expect(createColumnPreference(scope,'list-projects').getSnapshot()).toEqual(['name','createdAt'])
})
it('validates hydrated JSON, drops obsolete fields and retains the project name link', () => {
  const key = 'oryh.columns.v1:test:list-projects'
  for (const value of [null, {}, [], ['removed','__proto__']]) {
    localStorage.setItem(key,JSON.stringify(value))
    expect(createColumnPreference('test','list-projects').getSnapshot()).toEqual(['name','status','client','startDate'])
  }
  localStorage.setItem(key,JSON.stringify(['createdAt','removed','createdAt',7]))
  expect(createColumnPreference('test','list-projects').getSnapshot()).toEqual(['name','createdAt'])
})
it('persists changes and resets independently for every record list', () => {
  for (const kind of Object.keys(recordDefaultColumns) as (keyof typeof recordDefaultColumns)[]) {
    createColumnPreference('test',kind).set(['id'])
    expect(createColumnPreference('test',kind).getSnapshot()).toEqual(['id'])
    createColumnPreference('test',kind).set(recordDefaultColumns[kind])
    expect(createColumnPreference('test',kind).getSnapshot()).toEqual(recordDefaultColumns[kind])
  }
})
