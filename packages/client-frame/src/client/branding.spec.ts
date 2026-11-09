// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
// Public source export for tests; the runtime client entry is a browser module-loader bundle.
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import { dictionaries, english } from '@oryh/ai-client-kit/dictionary'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import * as FrameHost from '../index.js'
import { brandIndex } from '../index.js'
import { registerBranding } from './branding.js'

it('hides the default hero slogan beside the ORYH brand mark', () => {
  const selector = 'span:has(> [data-slot="conversation.hero.brand.mark"] .oryh-hero-brand) + span'
  expect(readFileSync('src/client/styles.css', 'utf8')).toContain(selector)
  document.body.innerHTML = `<div class="oryh-chat-seat"><span class="mark-holder"><span data-slot="conversation.hero.brand.mark"><span class="oryh-hero-brand">ORYH</span></span></span><span class="default-headline">探索未至之境</span></div>`
  expect(document.querySelector(selector)?.textContent).toBe('探索未至之境')
})

it('brands the initial HTML and installation manifest without changing application script or authentication', () => {
  const html = brandIndex(
    '<html><head><title>DSH Local Build</title><link rel="icon" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest"></head><body><script src="/app.js"></script></body></html>',
  )
  expect(html).not.toContain('DSH Local Build')
  expect(html).not.toContain('/favicon.svg')
  expect(html).not.toContain('/manifest.webmanifest')
  expect(html).toContain('<title>ORYH AI Client</title>')
  expect(html).toContain('<meta name="oryh-managed-settings" content="false">')
  expect(brandIndex('<html><head></head><body></body></html>', true)).toContain(
    '<meta name="oryh-managed-settings" content="true">',
  )
  expect(html).toContain('data:image/svg+xml,')
  expect(html).toContain('<script src="/app.js"></script>')
  const node = document.createElement('div')
  node.innerHTML = html
  const manifest = JSON.parse(
    decodeURIComponent(node.querySelector('link[rel=manifest]')!.getAttribute('href')!.split(',')[1]!),
  )
  expect(manifest.name).toBe('ORYH AI Client')
  expect(manifest.icons[0].src).toContain('data:image/svg+xml,')
})

it('elects ORYH occupants over native brand and notice cells and restores them on plugin unload', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  let dict = english as Record<string, string>
  const listeners = new Set<() => void>()
  const t = (key: string) => dict[key]!
  ctx.provide('locale', {
    bind: () => t,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  } as never)
  const slots = ctx.slots
  slots.register(
    {
      name: 'root',
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
        'settings.general.item': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
  const native = () => createElement('span', null, 'DSH Local Build')
  slots.register({ name: 'sidebar.brand.name' }, native)
  slots.register({ name: 'settings.onboarding', id: 'welcome-notice' }, native)
  slots.register({ name: 'settings.general.item', id: 'developer-tools' }, native)
  const previous = document.title
  const fiber = ctx.plugin({ inject: ['slots', 'locale'], apply: registerBranding })
  await fiber.await()
  expect(document.title).toBe('ORYH Workspace')
  dict = dictionaries
  for (const fn of listeners) fn()
  expect(document.title).toBe('ORYH 企业工作台')
  for (const name of [
    'sidebar.brand.mark',
    'sidebar.brand.name',
    'conversation.hero.brand.mark',
    'settings.onboarding',
    'settings.general.item',
  ] as const) {
    expect(slots.entries(name)[0]?.options.priority).toBe(-100)
  }
  const container = document.createElement('div'),
    root = createRoot(container)
  const mark = slots.entries('sidebar.brand.mark')[0]!.component
  await act(async () => root.render(createElement(mark as never, { size: 24 } as never)))
  expect(container.querySelector('svg[aria-label=ORYH] rect')).not.toBeNull()
  await act(async () => root.unmount())
  await fiber.dispose()
  expect(slots.entries('sidebar.brand.name')[0]?.component).toBe(native)
  expect(slots.entries('settings.onboarding')[0]?.component).toBe(native)
  expect(document.title).toBe(previous)
  expect(listeners.size).toBe(0)
  // Desktop keeps the native switch; the server shadows only this public row and retracts on unload.
  expect(slots.entries('settings.general.item').find(e => e.options.id === 'developer-tools')?.component).toBe(native)
  const managed = ctx.plugin({ inject: ['slots', 'locale'], apply: (child: Context) => registerBranding(child, true) })
  await managed.await()
  const row = slots.entries('settings.general.item').find(e => e.options.id === 'developer-tools')!
  expect(row.options.priority).toBe(-100)
  expect((row.component as () => unknown)()).toBeNull()
  await managed.dispose()
  expect(slots.entries('settings.general.item').find(e => e.options.id === 'developer-tools')?.component).toBe(native)
})

it('projects the server policy through the real Host index tap and retracts it on unload', async () => {
  const ctx = new Context()
  let transform: ((html: string) => string) | undefined
  ctx.provide('webServer', {
    tapIndex: (tap: (html: string) => string) => {
      transform = tap
      return () => {
        transform = undefined
      }
    },
  } as never)
  const fiber = ctx.plugin(FrameHost, { managedSettings: true })
  await fiber.await()
  const html = transform!('<html><head></head><body></body></html>')
  const node = document.createElement('div')
  node.innerHTML = html
  expect(node.querySelector('meta[name="oryh-managed-settings"]')?.getAttribute('content')).toBe('true')
  await fiber.dispose()
  expect(transform).toBeUndefined()
  await ctx.fiber.dispose()
})
