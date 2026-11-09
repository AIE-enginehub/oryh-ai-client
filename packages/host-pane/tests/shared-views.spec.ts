import type { Context } from '@deepseek-ai/cordis'
import type { OryhLibrary, SharedEntry } from '@oryh/dsh-connection'
import { expect, it, vi } from 'vitest'
import type { PaneService } from '../src/service.js'
import { SharedViews } from '../src/shared-views.js'

it.each(['resolve', 'reject'])('ignores an older shared-library response after a newer reload (%s)', async ending => {
  let finish = (_entries: SharedEntry[]) => {}
  let reject = (_error: Error) => {}
  const slow = new Promise<SharedEntry[]>((resolve, fail) => {
    finish = resolve
    reject = fail
  })
  const entry: SharedEntry = {
    kind: 'menu',
    id: '00000000-0000-4000-8000-000000000001',
    title: 'New',
    author: 'Colleague',
    mine: false,
    updatedAt: 'now',
    body: { collection: 'shipments', filters: {} },
  }
  let changed = (_kind: 'menu' | 'page') => {}
  let menus = 0
  const api = {
    list: async (kind: 'menu' | 'page') => (kind === 'page' ? [] : menus++ === 0 ? slow : [entry]),
    onChanged: (listener: typeof changed) => {
      changed = listener
      return () => {}
    },
  } as OryhLibrary
  const pane = {
    provideState: () => () => {},
    provideMenu: () => () => {},
    changedEverywhere: vi.fn(),
  } as unknown as PaneService
  const ctx = {
    get: () => api,
    effect: (run: () => unknown) => run(),
    inject: (_names: string[], run: (inner: unknown) => unknown) => run(ctx),
  } as unknown as Context
  const shared = new SharedViews(ctx, pane)
  shared.install()
  expect(shared.views()).toEqual([])
  changed('menu')
  await vi.waitFor(() => expect(shared.views()[0]?.label).toBe('New'))
  if (ending === 'resolve') finish([{ ...entry, title: 'Old' }])
  else reject(new Error('old outage'))
  await new Promise(resolve => setImmediate(resolve))
  expect(shared.views()[0]?.label).toBe('New')
  expect(pane.changedEverywhere).toHaveBeenCalledTimes(1)
})

it('serialises a withdrawal with an update so the update cannot bring the share back', async () => {
  const entry: SharedEntry = {
    kind: 'page',
    id: '00000000-0000-4000-8000-000000000002',
    title: 'Page',
    author: 'Me',
    mine: true,
    updatedAt: 'v1',
    body: { definition: {} },
  }
  const entries = new Map([[`${entry.kind}:${entry.id}`, entry]])
  let startRemove = () => {}
  const removeStarted = new Promise<void>(resolve => {
    startRemove = resolve
  })
  let releaseRemove = () => {}
  const removeGate = new Promise<void>(resolve => {
    releaseRemove = resolve
  })
  const get = vi.fn(async (kind: 'menu' | 'page', id: string) => entries.get(`${kind}:${id}`))
  const put = vi.fn(async (item: { kind: 'menu' | 'page'; id: string; title: string; body: unknown }) => {
    const stored = { ...entry, ...item, updatedAt: 'v2' }
    entries.set(`${item.kind}:${item.id}`, stored)
    return stored
  })
  const api = {
    list: async () => [...entries.values()],
    get,
    put,
    remove: async (kind: 'menu' | 'page', id: string) => {
      startRemove()
      await removeGate
      return entries.delete(`${kind}:${id}`)
    },
    onChanged: () => () => {},
  } as OryhLibrary
  const pane = {
    provideState: () => () => {},
    provideMenu: () => () => {},
    changedEverywhere: vi.fn(),
  } as unknown as PaneService
  const ctx = { get: () => api } as unknown as Context
  const shared = new SharedViews(ctx, pane)

  // The withdrawal has read the entry and is waiting in the library's remove.
  const withdrawal = shared.forget(entry.id, 'page')
  await removeStarted
  // A save that follows must wait for the withdrawal, not read the entry again while it is pending.
  const update = shared.update({ kind: 'page', id: entry.id, title: 'Page', body: { definition: { changed: true } } })
  await new Promise(resolve => setImmediate(resolve))
  expect(get).toHaveBeenCalledTimes(1)
  releaseRemove()
  await expect(withdrawal).resolves.toBe(true)
  await update
  expect(get).toHaveBeenCalledTimes(2)
  expect(put).not.toHaveBeenCalled()
  expect(entries.has(`page:${entry.id}`)).toBe(false)
})
