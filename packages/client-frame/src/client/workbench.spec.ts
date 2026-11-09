// @vitest-environment jsdom

import { dictionaries } from '@oryh/ai-client-kit/dictionary'
import { sourceHook, wordsOf } from '@oryh/ai-client-kit/testing'
import { canAccessPage } from '@oryh/ai-client-pages'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PaneService } from './pane-service.js'
import { MenuMirror } from './user-views.js'
import { type FrameEnv, Workbench } from './workbench.js'

const words = wordsOf(dictionaries)

/**
 * What the frame's entry would hand the workbench: a pane service and a menu mirror of the test's own,
 * with the hooks the renderer would make over them.
 */
function frameEnv(given: { api?: unknown; navigate: FrameEnv['navigate']; noSessions?: boolean; menu?: MenuMirror }) {
  const menu = given.menu ?? new MenuMirror()
  const pane = new PaneService(
    (given.api ?? { skillSync: async () => {}, paneMenu: async () => [] }) as never,
    menu,
    words,
    () => {},
  )
  const env: FrameEnv = {
    remote: (given.api ?? { skillSync: async () => {} }) as never,
    t: words,
    slots: { page: () => null, bridges: () => null },
    pageLabel: () => undefined,
    sessionId: undefined,
    noSessions: given.noSessions ?? false,
    navigate: given.navigate,
    chat: { startSession: () => false, showChat: () => {}, showSession: () => {} },
    activity: 'none',
    elsewhere: undefined,
    pane,
    usePane: sourceHook(pane.stream),
    usePaneLocal: sourceHook(pane.local),
    useMenu: scope => sourceHook(menu.source(scope))(state => state),
    prefs: { open: () => {}, set: () => {}, get: () => undefined },
    usePreference: () => undefined,
  }
  return env
}

const connection = (permissions: string[]) =>
  ({
    id: 'c',
    origin: 'https://oryh.test',
    identity: { tenant: { id: 't', name: '晶诚' }, user: { id: 'u', employeeId: 'e' }, permissions },
  }) as never

it('takes the person home from a restored page this account may not open', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const navigate = vi.fn()
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const env = frameEnv({ navigate })
  const render = (page: string, permissions: string[]) =>
    act(async () =>
      root.render(
        h(Workbench, {
          env,
          page: page as never,
          connection: connection(permissions),
          onDirtyChange: () => {},
          settings: null,
          notices: null,
        }),
      ),
    )
  try {
    // A salesperson's browser still holding the approver who used it before: approvals are not theirs.
    await render('inventory-items', ['timesheet.submit_own', 'order.submit_own'])
    expect(node.textContent).toContain('此功能不可用')
    // Nobody asked to see it: on a narrow screen the person is not taken away from Chat.
    expect(navigate).toHaveBeenCalledWith('my-open-todos', false)
    // Settings stay open while permissions are unknown, since that is where a person reconnects: the app
    // renders the workbench unverified only there, with no permissions at all.
    expect(canAccessPage({ user: { id: 'u' }, permissions: [] } as never, 'settings')).toBe(true)
  } finally {
    await act(async () => root.unmount())
    node.remove()
  }
})

it('takes the person to their first page from a restored menu entry that their menu does not hold', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const restored = 'view:22222222-2222-4222-8222-222222222222'
  // A salesperson with no employee record: 我的待办 is not theirs, so their first page is the list of
  // custom pages: the built-in order list is no page of its own any more.
  const account = (user: string) =>
    ({
      id: 'c',
      origin: 'https://oryh.test',
      identity: {
        tenant: { id: 't', name: '晶诚' },
        user: { id: user, employeeId: null },
        permissions: ['order.submit_own'],
      },
    }) as never
  const scope = (user: string) => JSON.stringify(['https://oryh.test', 't', user])
  let answer: (views: unknown[]) => void = () => {}
  const api = {
    skillSync: vi.fn(async () => {}),
    paneMenu: vi.fn(
      () =>
        new Promise(resolve => {
          answer = resolve
        }),
    ),
  }
  const navigate = vi.fn()
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const menu = new MenuMirror()
  const publishUserViews: MenuMirror['publish'] = (scope, views) => menu.publish(scope, views)
  // One environment per account, as the entry would make one for whoever is signed in.
  const envs = new Map<string, FrameEnv>()
  const envFor = (user: string, noSessions: boolean) => {
    const key = `${user}:${noSessions}`
    if (!envs.has(key)) envs.set(key, frameEnv({ api, navigate, noSessions, menu }))
    return envs.get(key)!
  }
  const render = (user: string, noSessions: boolean) =>
    act(async () =>
      root.render(
        h(Workbench, {
          key: user,
          env: envFor(user, noSessions),
          page: restored as never,
          connection: account(user),
          onDirtyChange: () => {},
          settings: null,
          notices: null,
        }),
      ),
    )
  try {
    // A fresh workspace holds no Chat session: none will come to publish this person's own entries, so
    // once their role's have arrived, those are the whole menu — and an entry from the last person to use
    // this browser is not among them.
    await render('li.yan', true)
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => answer([]))
    expect(navigate).toHaveBeenCalledWith('analytics', false)
    // Where sessions exist, one is about to be restored with the whole menu: the role's entries are not
    // taken for all of it, and the page waits for the session's list.
    navigate.mockClear()
    await render('wang.qiang', false)
    await act(async () => answer([]))
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => publishUserViews(scope('wang.qiang'), []))
    expect(navigate).toHaveBeenCalledWith('analytics', false)
    // An entry the role does give is opened, not sent home.
    navigate.mockClear()
    await render('zhou.ming', true)
    await act(async () =>
      answer([{ id: restored.slice(5), origin: 'role', label: '收付款', collection: 'payments', filters: {} }]),
    )
    expect(navigate).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    node.remove()
  }
})

it("drops a role's menu entry the moment none of the grants implying it is held", async () => {
  const { viewGranted } = await import('./user-views.js')
  const payroll = { origin: 'role' as const, grants: ['invoice.manage:payroll'] }
  expect(viewGranted({ permissions: ['invoice.manage:payroll'] }, payroll)).toBe(true)
  expect(viewGranted({ permissions: ['payment.record'] }, payroll)).toBe(false)
  // The person's own entries, and role entries from before grants were named, are the collection's to decide.
  expect(viewGranted({ permissions: [] }, {})).toBe(true)
  expect(viewGranted({ permissions: [] }, { origin: 'role' })).toBe(true)
})
