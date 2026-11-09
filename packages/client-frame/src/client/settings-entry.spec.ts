// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import { dictionaries, english } from '@oryh/ai-client-kit/dictionary'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FrameIdentity } from './layout-store.js'
import { registerSettingsEntry } from './settings-entry.js'

it('shows the ORYH identity instead of More, opens native settings and retracts on unload', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register(
    { name: 'root', children: { 'settings.launcher': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
  const native = () => null
  ctx.slots.register({ name: 'settings.launcher' }, native)
  const navigate = vi.fn(),
    openSettings = vi.fn()
  let person: FrameIdentity | undefined = { scope: 'one', email: 'test@oryh.test', company: 'ORYH Test' }
  const fiber = ctx.plugin({
    inject: ['slots'],
    apply: (child: Context) =>
      registerSettingsEntry(
        child,
        {
          getSnapshot: () => person,
          subscribe: () => () => {},
        },
        navigate,
      ),
  })
  await fiber.await()
  const entry = ctx.slots.entries('settings.launcher')[0]!
  expect(entry.options.priority).toBe(-100)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (wide = true, zh = false) => {
    await act(async () =>
      root.render(
        createElement(
          entry.component as never,
          {
            wide,
            settingsOpen: false,
            openSettings,
            useIdentity: (select: (value: FrameIdentity | undefined) => unknown) => select(person),
            t: (key: keyof typeof dictionaries) => (zh ? dictionaries : english)[key],
          } as never,
        ),
      ),
    )
  }
  await render()
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toContain('test@oryh.test')
  expect(trigger.textContent).not.toContain('More')
  await act(async () => trigger.click())
  const settings = [...document.querySelectorAll('[role="menuitem"]')].find(e =>
    e.textContent?.includes('Models & settings'),
  ) as HTMLElement
  await act(async () => settings.click())
  expect(openSettings).toHaveBeenCalledOnce()
  await act(async () => trigger.click())
  const connection = [...document.querySelectorAll('[role="menuitem"]')].find(e =>
    e.textContent?.includes('Organization connection'),
  ) as HTMLElement
  await act(async () => connection.click())
  expect(navigate).toHaveBeenCalledWith('settings')
  await render(false)
  expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('test@oryh.test')
  person = undefined
  await render(true, true)
  expect(container.textContent).toBe('模型与设置')
  expect(container.textContent).not.toContain('test@oryh.test')
  await act(async () => root.unmount())
  container.remove()
  await fiber.dispose()
  expect(ctx.slots.entries('settings.launcher')[0]?.component).toBe(native)
  await ctx.fiber.dispose()
})
