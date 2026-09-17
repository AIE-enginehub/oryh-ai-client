// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerFrame } from './layout.js'
import { createFrameStore } from './layout-store.js'
import { presentTheme } from './theme.js'

type PanelSource = { getSnapshot: () => { activePanelId: string | null }; subscribe: (fn: () => void) => () => void }

describe('external ORYH root composition', () => {
  beforeEach(() => localStorage.clear())
  it('owns compatible slots, wires layout actions, and releases them on unload', async () => {
    const ctx = new Context()
    const slots = new SlotCore()
    // Real public slot core; renderer service is the transport of the same register contract.
    // provideRoot belongs to the renderer registry, so the core records the contribution instead.
    const hooks: Record<string, unknown>[] = []
    Object.assign(slots, {
      provideRoot: (contribution: { hooks: Record<string, unknown> }) => {
        hooks.push(contribution.hooks)
        return () => {
          hooks.splice(hooks.indexOf(contribution.hooks), 1)
        }
      },
    })
    ctx.provide('slots', slots as never)
    const fiber = ctx.plugin({ apply: registerFrame })
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
    const replacement = ctx.plugin({ apply: registerFrame })
    await replacement.await()
    expect(slots.entriesOfSlot('root')).toHaveLength(1)
    await replacement.dispose()
    instance.dispose?.()
  })
  it('keeps business selection through chat, viewport and native panel transitions', () => {
    const instance = createFrameStore().create()
    const { actions, store } = instance
    actions.navigate('my-expense-claims')
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
    expect(store.getSnapshot().page).toBe('my-expense-claims')
    expect(store.getSnapshot().chatWidth).toBe(473)
    const anotherRoot = createFrameStore().create()
    expect(anotherRoot.store.getSnapshot().page).toBe('my-expense-claims')
    expect(anotherRoot.getSnapshot().chatWidth).toBe(473)
    expect(anotherRoot.getSnapshot().chatVisible).toBe(false)
    expect(anotherRoot.getSnapshot().viewport).toBe(1280)
    instance.dispose?.()
    anotherRoot.dispose?.()
  })
  it('projects public theme snapshots and restores prior DOM on plugin unload', async () => {
    const ctx = new Context()
    document.body.style.setProperty('--oryh-test-token', 'old')
    const snapshot = {
      active: { id: 'light', colorScheme: 'light', tokens: { '--oryh-test-token': 'new' } },
      fontSize: 16,
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
