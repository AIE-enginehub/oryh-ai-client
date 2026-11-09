// @vitest-environment jsdom

import { type PaneFace, useCommand, usePageContext } from '@oryh/ai-client-kit'
import { dictionaries } from '@oryh/ai-client-kit/dictionary'
import { fakePane, sourceHook, wordsOf } from '@oryh/ai-client-kit/testing'
import type { PageId } from '@oryh/ai-client-pages'
import type { PaneContext, PaneSync } from '@oryh/dsh-pane/types'
import { act, createContext, createElement as h, type ReactNode, useContext, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { businessSessionOf, showsSubagent, usePaneTarget } from './pane.js'
import { PaneService, type PaneTarget } from './pane-service.js'
import { MenuMirror } from './user-views.js'

const words = wordsOf(dictionaries)

// The plugin's entry makes one menu mirror and one pane service, and the renderer makes hooks over their
// sources. Tests have neither an entry nor a renderer, so the few lines below stand in for both: the
// contexts are the tests' own way of reaching into a mounted tree, not something a page reads.
const menu = new MenuMirror()
const publishUserViews: MenuMirror['publish'] = (scope, views) => menu.publish(scope, views)
function useUserViews(connection: { origin: string; identity: { tenant: { id: string }; user: { id: string } } }) {
  const { origin, identity } = connection
  return sourceHook(menu.source(JSON.stringify([origin, identity.tenant.id, identity.user.id])))(state => state)
}
const RemoteContext = createContext<unknown>(undefined)
const BusinessSessionContext = createContext<string | undefined>(undefined)
const FaceContext = createContext<PaneFace | undefined>(undefined)

/** The workbench's part: a pane service on the Remote the test supplies, told what is on show. */
function PaneProvider({
  children,
  noSessions = false,
  ...target
}: Omit<PaneTarget, 'noSessions'> & { noSessions?: boolean; children?: ReactNode }): ReactNode {
  const api = useContext(RemoteContext)
  const [pane] = useState(() => {
    const service = new PaneService(api as never, menu, words, () => {})
    const face: PaneFace = {
      usePane: sourceHook(service.stream),
      usePaneLocal: sourceHook(service.local),
      local: service.local,
    }
    return { service, face }
  })
  usePaneTarget(pane.service, { ...target, noSessions })
  return h(FaceContext.Provider, { value: pane.face }, children)
}

/** A page that reports its context and carries out page navigation, as the workbench does. */
function Page({ context, onOpen }: { context: PaneContext; onOpen: (page: string) => void }): ReactNode {
  const face = useContext(FaceContext)!
  usePageContext(face, context)
  useCommand(
    face,
    'navigation',
    undefined,
    command => {
      if (command.target !== 'page' || !command.page) return false
      onOpen(command.page)
      return true
    },
    [onOpen],
  )
  return null
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 80))
  })
}

describe('the pane provider', () => {
  it('binds, syncs every page change under a rising revision, and carries acknowledgements', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const pane = fakePane()
    const syncs: PaneSync[] = []
    const api = {
      paneBind: vi.fn(async () => ({ ready: true, message: '' })),
      paneUnbind: vi.fn(async () => {}),
      paneSync: vi.fn(async (request: PaneSync) => {
        syncs.push(request)
      }),
      openPane: vi.fn(() => ({ ...pane.stream, start: () => {}, dispose: async () => {} })),
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    const onOpen = vi.fn()
    const render = (page: PageId) =>
      act(async () =>
        root.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(
              BusinessSessionContext.Provider,
              { value: 's' },
              h(
                PaneProvider,
                { sessionId: 's', connectionId: 'c' as never, page, scope: 'scope' },
                h(Page, { context: { key: `${page}:list`, title: page, detail: '', scope: '' }, onOpen }),
              ),
            ),
          ),
        ),
      )
    try {
      for (const page of ['shipments', 'inventory-item-details', 'my-open-todos'] as const) {
        await render(page)
        await flush()
        expect(syncs.at(-1)).toMatchObject({ sessionId: 's', page, context: { key: `${page}:list` } })
      }
      expect(api.paneBind).toHaveBeenCalledTimes(1)
      // Strictly rising, and across page changes too: the Host drops a sync whose revision it already
      // holds for this instance, and that sync is the one carrying the new page and its acknowledgement.
      const revisions = syncs.map(s => s.revision)
      expect(revisions.every((revision, i) => i === 0 || revision > revisions[i - 1]!)).toBe(true)
      expect(new Set(syncs.map(s => s.instance)).size).toBe(1)
      // A command the page carries out is acknowledged on the next sync, and only once.
      await act(async () => {
        pane.command({ lane: 'navigation', id: 'go', payload: { target: 'page', page: 'settings' } })
      })
      await flush()
      expect(onOpen).toHaveBeenCalledWith('settings')
      expect(syncs.at(-1)?.acks).toEqual([{ lane: 'navigation', id: 'go' }])
      await render('settings')
      await flush()
      expect(syncs.at(-1)?.acks).toBeUndefined()
    } finally {
      await act(async () => root.unmount())
      node.remove()
    }
    expect(api.paneUnbind).toHaveBeenCalledWith('s')
  })
  it("waits for what colleagues share before calling the menu whole, and marks the person's own shared entries", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const pane = fakePane()
    const api = {
      paneBind: vi.fn(async () => ({ ready: true, message: '' })),
      paneUnbind: vi.fn(async () => {}),
      paneSync: vi.fn(async () => {}),
      paneMenu: vi.fn(async () => []),
      openPane: vi.fn(() => ({ ...pane.stream, start: () => {}, dispose: async () => {} })),
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    const mirrored = () => menu.source('sharing-scope').getSnapshot()
    const own = { id: 'own', label: '入库单', collection: 'shipments', filters: {} }
    const theirs = {
      id: 'theirs',
      label: '出库单',
      collection: 'shipments',
      filters: {},
      origin: 'shared' as const,
      sharedBy: '王强',
    }
    try {
      await act(async () =>
        root.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(PaneProvider, {
              sessionId: 's',
              connectionId: 'c' as never,
              page: 'my-open-todos',
              scope: 'sharing-scope',
            }),
          ),
        ),
      )
      await flush()
      // The library is there and not read yet: a page restored to a colleague's entry must not be told
      // the menu is whole and take that entry for withdrawn.
      await act(async () => pane.state({ userViews: [own], roleViews: [], sharedPending: true }))
      expect(mirrored().loaded).toBe(false)
      await act(async () => pane.state({ userViews: [own], roleViews: [], sharedViews: [theirs], sharedOwn: ['own'] }))
      expect(mirrored()).toEqual({ views: [theirs, { ...own, shared: true }], loaded: true, sharing: true })
      // Withdrawn by its author, and no longer shared by the person: the menu follows both.
      await act(async () => pane.state({ userViews: [own], roleViews: [], sharedViews: [], sharedOwn: [] }))
      expect(mirrored()).toEqual({ views: [own], loaded: true, sharing: true })
    } finally {
      await act(async () => root.unmount())
      node.remove()
    }
    // Where the deployment keeps no library the Host says nothing of sharing, and none is offered.
    menu.publish('desktop-scope', [own])
    expect(menu.source('desktop-scope').getSnapshot()).toEqual({ views: [own], loaded: true })
  })

  it('sends one sync for a burst of edits, carrying the last of them (docs/37 阶段 5 baseline)', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const pane = fakePane()
    const syncs: PaneSync[] = []
    const api = {
      paneBind: vi.fn(async () => ({ ready: true, message: '' })),
      paneUnbind: vi.fn(async () => {}),
      paneSync: vi.fn(async (request: PaneSync) => {
        syncs.push(request)
      }),
      openPane: vi.fn(() => ({ ...pane.stream, start: () => {}, dispose: async () => {} })),
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    const render = (detail: string) =>
      act(async () =>
        root.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(
              BusinessSessionContext.Provider,
              { value: 's' },
              h(
                PaneProvider,
                { sessionId: 's', connectionId: 'c' as never, page: 'inventory-item-details', scope: 'scope' },
                h(Page, {
                  context: { key: 'inventory-item-details:list', title: '项目', detail, scope: '' },
                  onOpen: () => {},
                }),
              ),
            ),
          ),
        ),
      )
    try {
      await render('')
      await flush()
      const before = syncs.length
      // Ten keystrokes in a filter box, faster than the debounce: the Host hears once, and hears the last.
      for (const detail of [
        '技',
        '技改',
        '技改项',
        '技改项目',
        '技改项目A',
        '技改项目AB',
        '技改项目ABC',
        '技改项目ABCD',
        '技改项目ABCDE',
        '技改项目一期',
      ])
        await render(detail)
      await flush()
      console.log(`burst of 10 edits: ${syncs.length - before} sync RPC(s)`)
      expect(syncs.length - before).toBe(1)
      expect(syncs.at(-1)?.context?.detail).toBe('技改项目一期')
    } finally {
      await act(async () => root.unmount())
      node.remove()
    }
  })
  it("shows the role's entries with no session open, without taking them for the whole menu", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const connection = { origin: 'https://oryh.test', identity: { tenant: { id: 't' }, user: { id: 'u' } } }
    const scope = JSON.stringify([connection.origin, 't', 'u'])
    const invoices = {
      id: '11111111-1111-4111-8111-111111111111',
      origin: 'role' as const,
      label: '发票·工资条',
      collection: 'invoices',
      filters: { direction: 'payroll' },
      display: { columns: [{ field: 'invoice_no', label: '发票号' }] },
    }
    const api = { paneMenu: vi.fn(async () => [invoices]) }
    const seen: { labels: string[]; loaded: boolean }[] = []
    function Probe(): ReactNode {
      const { views, loaded } = useUserViews(connection as never)
      seen.push({ labels: views.map(v => v.label), loaded })
      return null
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    try {
      await act(async () =>
        root.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(
              PaneProvider,
              { sessionId: undefined, connectionId: 'c' as never, page: 'my-open-todos', scope },
              h(Probe),
            ),
          ),
        ),
      )
      await flush()
      expect(api.paneMenu).toHaveBeenCalledWith('c')
      // The person's own entries are not among these, so a page restored to one of them keeps waiting.
      expect(seen.at(-1)).toEqual({ labels: ['发票·工资条'], loaded: false })
      // A session's whole menu replaces it, and the role's entries alone never replace a whole menu.
      await act(async () =>
        publishUserViews(scope, [invoices, { ...invoices, id: 'x', origin: undefined, label: '我的' }]),
      )
      expect(seen.at(-1)).toEqual({ labels: ['发票·工资条', '我的'], loaded: true })
      await act(async () => root.unmount())
      const again = createRoot(node)
      await act(async () =>
        again.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(
              PaneProvider,
              { sessionId: undefined, connectionId: 'c' as never, page: 'my-open-todos', scope },
              h(Probe),
            ),
          ),
        ),
      )
      await flush()
      expect(seen.at(-1)).toEqual({ labels: ['发票·工资条', '我的'], loaded: true })
      await act(async () => again.unmount())
    } finally {
      node.remove()
    }
  })
  it("takes the role's entries for the whole menu where the Host holds no session at all", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const connection = { origin: 'https://oryh.test', identity: { tenant: { id: 't' }, user: { id: 'new' } } }
    const scope = JSON.stringify([connection.origin, 't', 'new'])
    const api = { paneMenu: vi.fn(async () => []) }
    const seen: { labels: string[]; loaded: boolean }[] = []
    function Probe(): ReactNode {
      const { views, loaded } = useUserViews(connection as never)
      seen.push({ labels: views.map(v => v.label), loaded })
      return null
    }
    const node = document.createElement('div')
    document.body.append(node)
    const provider = () =>
      h(
        RemoteContext.Provider,
        { value: api as never },
        h(
          PaneProvider,
          { sessionId: undefined, noSessions: true, connectionId: 'c' as never, page: 'my-open-todos', scope },
          h(Probe),
        ),
      )
    const root = createRoot(node)
    try {
      await act(async () => root.render(provider()))
      await flush()
      // A fresh workspace: nothing is coming to publish more, so even no role entries is the whole menu.
      expect(seen.at(-1)).toEqual({ labels: [], loaded: true })
      // A session started since publishes its whole list, and a later read with none left does not undo it.
      const mine = { id: 'x', label: '我的', collection: 'sales-orders', filters: {} }
      await act(async () => publishUserViews(scope, [mine]))
      await act(async () => root.unmount())
      const again = createRoot(node)
      await act(async () => again.render(provider()))
      await flush()
      expect(api.paneMenu).toHaveBeenCalledTimes(2)
      expect(seen.at(-1)).toEqual({ labels: ['我的'], loaded: true })
      await act(async () => again.unmount())
    } finally {
      node.remove()
    }
  })
  it('stops after a refusal the Host decided on, and retries a transport failure', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const { LocalRemoteError } = await import('@oryh/ai-client-kit')
    const paneBind = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket'))
      .mockRejectedValueOnce(new LocalRemoteError('cross-connection-result', '该会话已绑定其他企业', true))
    const api = { paneBind, paneUnbind: vi.fn(async () => {}), paneSync: vi.fn(), openPane: vi.fn() }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    try {
      await act(async () =>
        root.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(PaneProvider, { sessionId: 's', connectionId: 'c' as never, page: 'shipments', scope: 'scope' }, null),
          ),
        ),
      )
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 700))
      })
      expect(paneBind).toHaveBeenCalledTimes(2)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 1200))
      })
      // The refusal is final: no third attempt, and nothing was ever synced.
      expect(paneBind).toHaveBeenCalledTimes(2)
      expect(api.paneSync).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      node.remove()
    }
    expect(api.paneUnbind).not.toHaveBeenCalled()
  })
  it('gives up on a Host that takes the binding and refuses every stream, and starts over once one delivers', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    // Each stream is refused as soon as it starts, until the test says the Host is well again.
    let healthy = false
    const openPane = vi.fn(() => {
      const pane = fakePane({ status: 'connecting' })
      return {
        ...pane.stream,
        start: () => pane.publish(healthy ? { status: 'synced' } : { status: 'rejected', error: '协议错误' }),
        dispose: async () => {},
        publish: pane.publish,
      }
    })
    const api = { paneBind: vi.fn(async () => {}), paneUnbind: vi.fn(async () => {}), paneSync: vi.fn(), openPane }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    try {
      await act(async () =>
        root.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(
              PaneProvider,
              { sessionId: 's', connectionId: 'c' as never, page: 'my-open-todos', scope: 'scope' },
              null,
            ),
          ),
        ),
      )
      // Binding succeeded every time, and that used to count as recovery: a new stream twice a second, for good.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(openPane).toHaveBeenCalledTimes(6)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(openPane).toHaveBeenCalledTimes(6)
    } finally {
      await act(async () => root.unmount())
      node.remove()
      vi.useRealTimers()
    }
    // A stream that delivered its state is what earns the tries back.
    healthy = true
    vi.useFakeTimers()
    const again = document.createElement('div')
    document.body.append(again)
    const second = createRoot(again)
    try {
      await act(async () =>
        second.render(
          h(
            RemoteContext.Provider,
            { value: api as never },
            h(
              PaneProvider,
              { sessionId: 's', connectionId: 'c' as never, page: 'my-open-todos', scope: 'scope' },
              null,
            ),
          ),
        ),
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      const first = openPane.mock.results.at(-1)!.value as { publish(next: object): void }
      healthy = false
      const before = openPane.mock.calls.length
      await act(async () => {
        first.publish({ status: 'rejected', error: 'Host 重启' })
        await vi.advanceTimersByTimeAsync(60_000)
      })
      // The whole budget again, counted from the stream that had been healthy.
      expect(openPane.mock.calls.length - before).toBe(5)
    } finally {
      await act(async () => second.unmount())
      again.remove()
      vi.useRealTimers()
    }
  })
})

describe('the pane service', () => {
  it('keeps its binding through page changes, and waits before sending again a sync the Host did not take', async () => {
    vi.useFakeTimers()
    try {
      const pane = fakePane()
      const paneSync = vi.fn().mockRejectedValueOnce(new Error('socket')).mockResolvedValue(undefined)
      const api = {
        paneBind: vi.fn(async () => ({ ready: true, message: '' })),
        paneUnbind: vi.fn(async () => {}),
        paneSync,
        openPane: vi.fn(() => ({ ...pane.stream, start: () => {}, dispose: async () => {} })),
      }
      const service = new PaneService(api as never, new MenuMirror(), words, () => {})
      const target = { sessionId: 's', noSessions: false, connectionId: 'c' as never, scope: 'scope' }
      service.show({ ...target, page: 'my-open-todos' })
      await vi.advanceTimersByTimeAsync(60)
      expect(paneSync).toHaveBeenCalledTimes(1)
      // Refused by the carrier: not asked again at once, which used to be twenty-five times a second.
      await vi.advanceTimersByTimeAsync(300)
      expect(paneSync).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(300)
      expect(paneSync).toHaveBeenCalledTimes(2)
      // Another page is the same binding: one more sync, under a higher revision, and no second bind.
      service.show({ ...target, page: 'analytics' })
      await vi.advanceTimersByTimeAsync(60)
      expect(api.paneBind).toHaveBeenCalledTimes(1)
      expect(paneSync.mock.calls.at(-1)?.[0]).toMatchObject({ page: 'analytics', revision: 3 })
      // What the pages read is one source for as long as the service lives, whatever is bound.
      const stream = service.stream
      service.show({ ...target, sessionId: 'other', page: 'analytics' })
      await vi.advanceTimersByTimeAsync(60)
      expect(api.paneUnbind).toHaveBeenCalledWith('s')
      expect(api.paneBind).toHaveBeenCalledTimes(2)
      expect(service.stream).toBe(stream)
      service.dispose()
      expect(api.paneUnbind).toHaveBeenCalledWith('other')
      expect(service.stream.getSnapshot().status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the Chat the pane binds to', () => {
  const row = (id: string, fields: { mainView?: number; origin?: 'subagent'; parentId?: string } = {}) => ({
    id,
    retainedBy: fields.mainView ? { mainView: fields.mainView } : {},
    ...(fields.origin ? { origin: fields.origin } : {}),
    ...(fields.parentId ? { parentId: fields.parentId } : {}),
  })
  it('is the session the main view holds, and a Chat when that is one of its subagents', () => {
    expect(businessSessionOf({ byId: {} })).toBeUndefined()
    expect(businessSessionOf({ byId: { chat: row('chat', { mainView: 1 }), other: row('other') } })).toBe('chat')
    // A page refresh opened from the Chat's list of runs: the pane stays on the Chat.
    const run = row('run', { mainView: 1, origin: 'subagent', parentId: 'chat' })
    expect(businessSessionOf({ byId: { chat: row('chat'), run } })).toBe('chat')
    // Nested runs lead back to the Chat; a parent the list has not loaded is still the Chat's id.
    const nested = row('nested', { mainView: 1, origin: 'subagent', parentId: 'run' })
    expect(
      businessSessionOf({
        byId: { chat: row('chat'), run: row('run', { origin: 'subagent', parentId: 'chat' }), nested },
      }),
    ).toBe('chat')
    expect(businessSessionOf({ byId: { run } })).toBe('chat')
    // A branch copied from a Chat is a session of its own; the pane refuses it where it binds.
    expect(businessSessionOf({ byId: { fork: row('fork', { mainView: 1, parentId: 'chat' }) } })).toBe('fork')
  })
  it('knows when what is on show is a run of the Chat and not the Chat, so the Chat can be brought back', () => {
    const run = row('run', { mainView: 1, origin: 'subagent', parentId: 'chat' })
    // A review being read: what a page then asks goes to the Chat, which is not the conversation on show.
    expect(showsSubagent({ byId: { chat: row('chat'), run } })).toBe(true)
    expect(showsSubagent({ byId: { chat: row('chat', { mainView: 1 }), run: { ...run, retainedBy: {} } } })).toBe(false)
    expect(showsSubagent({ byId: { fork: row('fork', { mainView: 1, parentId: 'chat' }) } })).toBe(false)
    expect(showsSubagent({ byId: {} })).toBe(false)
  })
})
