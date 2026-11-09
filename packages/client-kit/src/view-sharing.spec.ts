// @vitest-environment jsdom

import type { UserViewSummary } from '@oryh/dsh-pane/types'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FrameShare } from './frame.js'
import { fakeFace } from './pane-test.js'
import { useViewSharing } from './view-sharing.js'

const own: UserViewSummary = { id: 'own', label: '入库单', collection: 'shipments', filters: {} }
const theirs: UserViewSummary = { ...own, id: 'theirs', origin: 'shared', sharedBy: '王强' }

/** The header of a list, as far as sharing goes. */
function Header({ face, view }: { face: ReturnType<typeof fakeFace>['face']; view?: UserViewSummary }): ReactNode {
  const sharing = useViewSharing(face, view)
  return h('div', null, h('span', { className: 'note' }, sharing.note), sharing.action, sharing.error)
}

async function mount(remote: object, frame: Partial<FrameShare>, view?: UserViewSummary) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const render = (nextFrame: Partial<FrameShare>, nextView?: UserViewSummary) =>
    act(async () =>
      root.render(
        h(Header, { face: fakeFace({ remote, frame: nextFrame }).face, ...(nextView ? { view: nextView } : {}) }),
      ),
    )
  await render(frame, view)
  return {
    node,
    render,
    button: () => node.querySelector('button'),
    note: () => node.querySelector('.note')?.textContent,
    close: async () => {
      await act(async () => root.unmount())
      node.remove()
    },
  }
}
const sharing = (views: UserViewSummary[] = []) => ({ views, loaded: true, sharing: true })

it("shares the person's own entry from its page, and withdraws it", async () => {
  const paneShareView = vi.fn(async () => {})
  const page = await mount({ paneShareView }, { menu: sharing([own]) }, own)
  try {
    expect(page.button()?.textContent).toBe('共享给同事')
    expect(page.note()).toBe('')
    await act(async () => page.button()!.click())
    expect(paneShareView).toHaveBeenCalledWith({ sessionId: 's', connectionId: 'c', userViewId: 'own', shared: true })
    // The Host publishes the menu again, and the entry comes back saying it is shared.
    const shared = { ...own, shared: true }
    await page.render({ menu: sharing([shared]) }, shared)
    expect(page.note()).toBe('已共享给同事')
    expect(page.button()?.textContent).toBe('取消共享')
    await act(async () => page.button()!.click())
    expect(paneShareView).toHaveBeenLastCalledWith(expect.objectContaining({ userViewId: 'own', shared: false }))
  } finally {
    await page.close()
  }
})

it("says whose a colleague's entry is, and opens the copy once the menu has it", async () => {
  const paneCopySharedView = vi.fn(async () => ({ kind: 'menu' as const, id: 'copy', label: '入库单' }))
  const navigate = vi.fn()
  const page = await mount({ paneCopySharedView }, { menu: sharing([theirs]), navigate }, theirs)
  try {
    expect(page.note()).toBe('王强 共享')
    expect(page.button()?.textContent).toBe('复制为我的')
    await act(async () => page.button()!.click())
    expect(paneCopySharedView).toHaveBeenCalledWith({ sessionId: 's', connectionId: 'c', sharedViewId: 'theirs' })
    // Not before the menu has the copy: a page opened as an entry the menu lacks reads as one removed.
    expect(navigate).not.toHaveBeenCalled()
    await page.render({ menu: sharing([theirs, { ...own, id: 'copy' }]), navigate }, theirs)
    expect(navigate).toHaveBeenCalledWith('view:copy')
  } finally {
    await page.close()
  }
})

it("takes the person to their own pages after copying a colleague's page, where the copy waits for its first run", async () => {
  const paneCopySharedView = vi.fn(async () => ({ kind: 'page' as const, id: 'copy', label: '订单统计' }))
  const navigate = vi.fn()
  const shared: UserViewSummary = { ...theirs, label: '订单统计', collection: 'custom-pages' }
  const page = await mount({ paneCopySharedView }, { menu: sharing([shared]), navigate }, shared)
  try {
    await act(async () => page.button()!.click())
    // A page enters the menu only once it has run, so there is no entry to wait for.
    expect(navigate).toHaveBeenCalledWith('analytics')
  } finally {
    await page.close()
  }
})

it('says what went wrong, and offers nothing where it cannot be done', async () => {
  const paneShareView = vi.fn(async () => {
    throw new Error('你共享的菜单项已达 30 个上限，请先取消不用的共享。')
  })
  const page = await mount({ paneShareView }, { menu: sharing([own]) }, own)
  try {
    await act(async () => page.button()!.click())
    expect(page.node.querySelector('[role=alert]')?.textContent).toContain('30 个上限')
    // No session open: the entry lives in a session's workspace, so the button waits and says why.
    await page.render({ menu: sharing([own]), sessionId: undefined }, own)
    expect(page.button()?.disabled).toBe(true)
    expect(page.button()?.title).toBe('先在右侧 Chat 里打开一个会话。')
    // A colleague's entry with no session open: the menu came from the connection alone, and the entry
    // still says whose it is and that a copy needs a session.
    await page.render({ menu: { views: [theirs], loaded: true }, sessionId: undefined }, theirs)
    expect(page.note()).toBe('王强 共享')
    expect(page.button()?.textContent).toBe('复制为我的')
    expect(page.button()?.disabled).toBe(true)
    // The desktop keeps no library; a built-in list is no entry; a role's entry is nobody's to share.
    await page.render({ menu: { views: [own], loaded: true } }, own)
    expect(page.button()).toBeNull()
    await page.render({ menu: sharing() })
    expect(page.button()).toBeNull()
    await page.render({ menu: sharing() }, { ...own, origin: 'role' })
    expect(page.button()).toBeNull()
  } finally {
    await page.close()
  }
})
