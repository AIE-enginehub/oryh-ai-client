// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import {
  createViewPreference,
  filterPreference,
  pagePreference,
  productPreference,
  queryFieldsPreference,
} from './view-preferences.js'

beforeEach(() => localStorage.clear())
it('restores filters, ordering and page, with functional updates and independent lists', () => {
  const defaults = { text: '', status: '', from: '', to: '', descending: true }
  const filter = createViewPreference('user', 'projects:filter', defaults, filterPreference)
  filter.set(v => ({ ...v, text: 'ABC', status: 'active', from: '2026-01-01', descending: false }))
  createViewPreference('user', 'projects:page', 1, pagePreference).set(3)
  expect(createViewPreference('user', 'projects:filter', defaults, filterPreference).getSnapshot()).toMatchObject({
    text: 'ABC',
    status: 'active',
    descending: false,
  })
  expect(createViewPreference('user', 'projects:page', 1, pagePreference).getSnapshot()).toBe(3)
  expect(createViewPreference('user', 'todos:filter', defaults, filterPreference).getSnapshot()).toEqual(defaults)
})
it('rejects invalid persisted shapes and strips extra data', () => {
  localStorage.setItem('oryh.view.v1:u:page', '-1')
  expect(createViewPreference('u', 'page', 1, pagePreference).getSnapshot()).toBe(1)
  // The schema checks shape only. Whether a field name is one the list accepts is the deployment's call,
  // made when the page reads the endpoint's declared parameters — a fixed list here would hardcode it again.
  localStorage.setItem('oryh.view.v1:u:fields', '["reason","reason"]')
  expect(createViewPreference('u', 'fields', [], queryFieldsPreference).getSnapshot()).toEqual(['reason'])
  localStorage.setItem('oryh.view.v1:u:badFields', '["Drop Table","../x"]')
  expect(createViewPreference('u', 'badFields', [], queryFieldsPreference).getSnapshot()).toEqual([])
  localStorage.setItem(
    'oryh.view.v1:u:products',
    JSON.stringify([{ id: 'p', name: 'Product', code: 'P1', extra: 'discard' }]),
  )
  expect(createViewPreference('u', 'products', [], productPreference).getSnapshot()).toEqual([
    { id: 'p', name: 'Product', code: 'P1' },
  ])
})
