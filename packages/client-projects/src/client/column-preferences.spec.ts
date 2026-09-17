// @vitest-environment jsdom
import { createColumnPreference } from '@oryh/dsh-client-frame/client'
import { beforeEach, expect, it, vi } from 'vitest'

// The frame re-exports Fluent, which does not load under Node; nothing here renders it.
vi.mock('@fluentui/react-components', () => ({}))

import { projectCatalog } from './project-column-catalog.js'

beforeEach(() => {
  localStorage.clear()
})
it('validates hydrated JSON, drops obsolete fields and retains the project name link', () => {
  const key = 'oryh.columns.v1:test:list-projects'
  for (const value of [null, {}, [], ['removed', '__proto__']]) {
    localStorage.setItem(key, JSON.stringify(value))
    expect(createColumnPreference('test', 'list-projects', projectCatalog).getSnapshot()).toEqual([
      'name',
      'status',
      'client',
      'startDate',
    ])
  }
  localStorage.setItem(key, JSON.stringify(['createdAt', 'removed', 'createdAt', 7]))
  expect(createColumnPreference('test', 'list-projects', projectCatalog).getSnapshot()).toEqual(['name', 'createdAt'])
})
