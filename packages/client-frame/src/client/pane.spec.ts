// @vitest-environment jsdom
import type { PageId } from '@oryh/ai-client-pages'
import type { PaneContext, PaneSync } from '@oryh/dsh-pane/types'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BusinessSessionContext, PaneProvider, useCommand, usePageContext } from './pane.js'
import { fakePane } from './pane-test.js'
import { RemoteContext } from './remote.js'

/** A page that reports its context and carries out page navigation, as the workbench does. */
function Page({ context, onOpen }: { context: PaneContext; onOpen: (page: string) => void }): ReactNode {
  usePageContext(context)
  useCommand(
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
      openPane: vi.fn(() => ({ ...pane.value.stream, start: () => {}, dispose: async () => {} })),
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
      for (const page of ['timesheets', 'list-projects', 'my-open-todos'] as const) {
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
      openPane: vi.fn(() => ({ ...pane.value.stream, start: () => {}, dispose: async () => {} })),
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
                { sessionId: 's', connectionId: 'c' as never, page: 'list-projects', scope: 'scope' },
                h(Page, { context: { key: 'list-projects:list', title: '项目', detail, scope: '' }, onOpen: () => {} }),
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
  it('stops after a refusal the Host decided on, and retries a transport failure', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const { LocalRemoteError } = await import('./remote.js')
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
            h(PaneProvider, { sessionId: 's', connectionId: 'c' as never, page: 'timesheets', scope: 'scope' }, null),
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
})
