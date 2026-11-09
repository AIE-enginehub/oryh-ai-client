// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatWantsAttention, registerFrame } from './layout.js'
import { createFrameStore } from './layout-store.js'
import { presentTheme } from './theme.js'

type PanelSource = { getSnapshot: () => { activePanelId: string | null }; subscribe: (fn: () => void) => () => void }

/** A signed-in person at one company, as the app reports them to the frame. */
const person = (user: string) => ({
  scope: JSON.stringify(['https://oryh.test', 't', user]),
  company: '晶诚',
  email: `${user}@oryh.test`,
})

describe('external ORYH root composition', () => {
  beforeEach(() => localStorage.clear())
  it('owns compatible slots, wires layout actions, and releases them on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.slots
    // Use the real registry for late settings-slot injection; capture the root hook contribution.
    const hooks: Record<string, unknown>[] = []
    Object.assign(slots, {
      provideRoot: (contribution: { hooks: Record<string, unknown> }) => {
        hooks.push(contribution.hooks)
        return () => {
          hooks.splice(hooks.indexOf(contribution.hooks), 1)
        }
      },
    })
    const fiber = ctx.plugin({ inject: ['slots'], apply: registerFrame })
    await fiber.await()
    expect(slots.entriesOfSlot('root')).toHaveLength(1)
    expect(slots.spec('oryh.business')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('main')).toEqual({ kind: 'keyed', scope: 'root' })
    expect(slots.spec('rightbar')).toEqual({ kind: 'single', scope: 'root' })
    const entry = slots.entriesOfSlot('root')[0]!
    const instance = (entry.store as ReturnType<typeof createFrameStore>).create()
    ctx.layout.toggleSidebar()
    expect(instance.getSnapshot().collapsed).toBe(false)
    ctx.layout.openRightbar(true, true)
    expect(instance.getSnapshot().rightbarFullscreen).toBe(true)
    ctx.layout.closeRightbar()
    expect(instance.getSnapshot().rightbarShown).toBe(false)
    // The native sidebar reads panel selection through this standard hook.
    const panels = hooks[0]!.panelInfo as PanelSource
    expect(panels.getSnapshot().activePanelId).toBeNull()
    expect(() => ctx.layout.selectPanel('absent' as never)).toThrow(/not registered/)
    const removePanel = slots.register({ name: 'main', key: 'conversation' } as never, () => null)
    ctx.layout.selectPanel('conversation' as never)
    expect(panels.getSnapshot().activePanelId).toBe('conversation')
    // A panel disappearing with its plugin returns the centre to the Conversation.
    // Slot subscriptions are microtask-batched, so retention lands after the disposer returns.
    removePanel()
    await vi.waitFor(() => {
      expect(panels.getSnapshot().activePanelId).toBeNull()
    })
    expect(() => ctx.layout.selectPanel('conversation' as never)).toThrow(/not registered/)
    const superseded = ctx.layout.beginNavigation()
    const pending = ctx.layout.beginNavigation()
    expect(superseded.aborted).toBe(true)
    expect(pending.aborted).toBe(false)
    const stale = slots.register({ name: 'oryh.business' }, () => null)
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entriesOfSlot('root')).toHaveLength(0)
    expect(slots.spec('oryh.business')).toBeUndefined()
    expect(slots.spec('main')).toBeUndefined()
    expect(hooks).toHaveLength(0)
    expect(pending.aborted).toBe(true)
    expect(() => stale()).not.toThrow()
    const replacement = ctx.plugin({ inject: ['slots'], apply: registerFrame })
    await replacement.await()
    expect(slots.entriesOfSlot('root')).toHaveLength(1)
    await replacement.dispose()
    instance.dispose?.()
  })
  it('keeps business selection through chat, viewport and native panel transitions', () => {
    const instance = createFrameStore().create()
    const { actions, store } = instance
    actions.setIdentity(person('wu'))
    actions.navigate('sales-orders')
    expect(store.getSnapshot().chatWidth).toBe(360)
    actions.setChatWidth(473)
    expect(store.getSnapshot().chatWidth).toBe(473)
    actions.setChatWidth(10)
    expect(store.getSnapshot().chatWidth).toBe(280)
    actions.setChatWidth(NaN)
    expect(store.getSnapshot().chatWidth).toBe(280)
    actions.setChatWidth(473)
    actions.showChat()
    actions.measure(390)
    actions.toggleChat()
    expect(store.getSnapshot().focus).toBe('business')
    actions.openRightbar(false, true)
    actions.closeRightbar()
    actions.showBusiness()
    expect(store.getSnapshot().page).toBe('sales-orders')
    expect(store.getSnapshot().chatWidth).toBe(473)
    const anotherRoot = createFrameStore().create()
    // The layout is the browser's and is back at once; the page is the person's and is back with them.
    expect(anotherRoot.getSnapshot().chatWidth).toBe(473)
    expect(anotherRoot.getSnapshot().chatVisible).toBe(false)
    expect(anotherRoot.getSnapshot().viewport).toBe(1280)
    anotherRoot.actions.setIdentity(person('wu'))
    expect(anotherRoot.store.getSnapshot().page).toBe('sales-orders')
    instance.dispose?.()
    anotherRoot.dispose?.()
  })
  it('keeps each page for the person who was on it, so the next account in this browser starts from its own', () => {
    const entry = 'view:11111111-1111-4111-8111-111111111111' as const
    // Kept per browser before, the page was whoever's came last: it is not handed to anyone.
    localStorage.setItem(
      'oryh.view.v1:browser:frame',
      JSON.stringify({ page: entry, collapsed: false, chatWidth: 500 }),
    )
    const first = createFrameStore().create()
    expect(first.getSnapshot()).toMatchObject({ page: 'my-open-todos', collapsed: false, chatWidth: 500 })
    first.actions.setIdentity(person('wu'))
    expect(first.getSnapshot().page).toBe('my-open-todos')
    first.actions.navigate(entry)
    expect(localStorage.getItem(`oryh.view.v1:${person('wu').scope}:frame:page`)).toBe(JSON.stringify(entry))
    expect(JSON.parse(localStorage.getItem('oryh.view.v1:browser:frame')!)).not.toHaveProperty('page')
    first.dispose?.()
    // 王强 signs in next in the same browser: his own last page, not an entry from 吴倩's menu.
    const second = createFrameStore().create()
    second.actions.setIdentity(person('wang'))
    expect(second.getSnapshot().page).toBe('my-open-todos')
    second.actions.navigate('sales-orders')
    // Re-verified, the identity is withdrawn and restated; a page opened in between stands and is kept.
    second.actions.setIdentity(undefined)
    second.actions.navigate('shipments', false)
    second.actions.setIdentity({ ...person('wang'), allowedPages: ['shipments'] })
    expect(second.getSnapshot().page).toBe('shipments')
    // Another account in the same tab gets theirs back, and so does he on returning.
    second.actions.setIdentity(person('wu'))
    expect(second.getSnapshot().page).toBe(entry)
    second.actions.setIdentity(person('wang'))
    expect(second.getSnapshot().page).toBe('shipments')
    second.dispose?.()
  })
  it('opens what the agent opens to answer behind Chat, and brings forward only what was asked for', () => {
    const instance = createFrameStore().create()
    const { actions, store } = instance
    actions.navigate('my-open-todos')
    actions.showChat()
    // Opened to answer a question: the person keeps reading the reply, and the switch says something changed.
    actions.navigate('inventory-items', false)
    expect(store.getSnapshot()).toMatchObject({ page: 'inventory-items', focus: 'chat', unseen: true })
    actions.showBusiness()
    expect(store.getSnapshot().unseen).toBe(false)
    // Asked to show it — or chosen in the menu — it comes forward.
    actions.showChat()
    actions.navigate('shipments', true)
    expect(store.getSnapshot()).toMatchObject({ page: 'shipments', focus: 'business', unseen: false })
    actions.showChat()
    actions.navigate('my-open-todos')
    expect(store.getSnapshot().focus).toBe('business')
    instance.dispose?.()
  })
  it('marks Chat when the agent answers where the person cannot see it, and only there', () => {
    const instance = createFrameStore().create()
    const { actions, store } = instance
    // Wide: both are on screen, so a reply is seen as it comes.
    actions.measure(1280)
    actions.navigate('sales-orders', true)
    actions.chatReplied()
    expect(store.getSnapshot().chatUnseen).toBe(false)
    // Narrow, and a fill has brought the business view forward: the reply lands behind it.
    actions.measure(600)
    actions.showChat()
    actions.navigate('sales-orders', true)
    actions.chatReplied()
    expect(store.getSnapshot()).toMatchObject({ focus: 'business', chatUnseen: true })
    actions.showChat()
    expect(store.getSnapshot().chatUnseen).toBe(false)
    // Reading Chat on a narrow screen: nothing to mark.
    actions.chatReplied()
    expect(store.getSnapshot().chatUnseen).toBe(false)
    // Widening the window until both show clears a mark that is no longer true.
    actions.showBusiness()
    actions.chatReplied()
    expect(store.getSnapshot().chatUnseen).toBe(true)
    actions.measure(1280)
    expect(store.getSnapshot().chatUnseen).toBe(false)
    // Wide with Chat hidden: marked until Chat is shown again.
    actions.toggleChat()
    actions.chatReplied()
    expect(store.getSnapshot()).toMatchObject({ chatVisible: false, chatUnseen: true })
    actions.toggleChat()
    expect(store.getSnapshot()).toMatchObject({ chatVisible: true, chatUnseen: false })
    instance.dispose?.()
  })
  it('takes a finished turn or a question for something to mark, and a session switch for nothing', () => {
    const at = (session: string | undefined, activity: 'none' | 'running' | 'waiting' | 'idle') => ({
      session,
      activity,
    })
    expect(chatWantsAttention(at('s', 'running'), at('s', 'idle'))).toBe(true)
    expect(chatWantsAttention(at('s', 'running'), at('s', 'waiting'))).toBe(true)
    expect(chatWantsAttention(at('s', 'idle'), at('s', 'waiting'))).toBe(true)
    // First sight of a session, a session that was idle all along, a turn starting, another session.
    expect(chatWantsAttention(undefined, at('s', 'idle'))).toBe(false)
    expect(chatWantsAttention(at('s', 'none'), at('s', 'idle'))).toBe(false)
    expect(chatWantsAttention(at('s', 'idle'), at('s', 'running'))).toBe(false)
    expect(chatWantsAttention(at('s', 'waiting'), at('s', 'waiting'))).toBe(false)
    expect(chatWantsAttention(at('a', 'running'), at('b', 'idle'))).toBe(false)
  })
  it('projects public theme snapshots and restores prior DOM on plugin unload', async () => {
    const ctx = new Context()
    document.body.style.setProperty('--oryh-test-token', 'old')
    const snapshot = {
      active: { id: 'light', colorScheme: 'light', tokens: { '--oryh-test-token': 'new' } },
      preference: 'light',
      fontSizes: { text: 16, code: 14, terminal: 13 },
      fontFamilies: { text: '', code: '', terminal: '' },
    } as ThemeSnapshot
    ctx.provide('theme', { getTheme: () => snapshot } as never)
    const fiber = ctx.plugin({ apply: presentTheme })
    await fiber.await()
    expect(document.body.style.getPropertyValue('--oryh-test-token')).toBe('new')
    ctx.emit('theme/change', { ...snapshot, active: { id: 'dark', colorScheme: 'dark', tokens: {} } })
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.body.style.getPropertyValue('--oryh-test-token')).toBe('old')
    await fiber.dispose()
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(document.body.style.getPropertyValue('--oryh-test-token')).toBe('old')
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull()
    document.body.style.removeProperty('--oryh-test-token')
  })
})
