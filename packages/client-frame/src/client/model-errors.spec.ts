// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import { dictionaries, english } from '@oryh/ai-client-kit/dictionary'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { registerModelErrors } from './model-errors.js'

it('replaces missing model credentials with bilingual guidance and preserves other native failures and unload', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', { bind: () => (key: string) => `native:${key}` } as never)
  ctx.slots.register(
    { name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } } as never,
    () => null,
  )
  const native = ({ node, t }: { node: { data: { code: string } }; t: (key: string) => string }) =>
    createElement('p', null, `${t('failure')}:${node.data.code}`)
  ctx.slots.register({ name: 'conversation.chat.node', key: 'turn-error' }, native as never)
  const fiber = ctx.plugin({ inject: ['slots'], apply: registerModelErrors })
  await fiber.await()
  const elected = ctx.slots.entries('conversation.chat.node')[0]!
  expect(elected.options.priority).toBe(-100)
  const container = document.createElement('div')
  const root = createRoot(container)
  const render = async (code: string, zh = false) => {
    await act(async () =>
      root.render(
        createElement(
          elected.component as never,
          {
            node: { data: { code, message: 'llm-pi-ai: private provider diagnostic' } },
            t: (key: keyof typeof dictionaries) => (zh ? dictionaries : english)[key],
          } as never,
        ),
      ),
    )
  }
  for (const zh of [true, false]) {
    await render('MISSING_CREDENTIAL', zh)
    expect(container.textContent).toContain(zh ? '企业连接不受影响' : 'organization connection is unaffected')
    expect(container.textContent).toContain('Models')
    expect(container.textContent).not.toContain('llm-pi-ai')
    expect(container.textContent).not.toContain('DEEPSEEK_API_KEY')
  }
  await render('AUTH', true)
  expect(container.textContent).toContain('服务地址及账号权限')
  await render('UNKNOWN_MODEL', true)
  expect(container.textContent).toContain('重新选择')
  for (const code of ['QUOTA', 'INTERRUPTED', 'ACCOUNT_SIGNED_OUT', 'NEW_FAILURE']) {
    await render(code)
    expect(container.textContent).toBe(`native:failure:${code}`)
  }
  await act(async () => root.unmount())
  await fiber.dispose()
  expect(ctx.slots.entries('conversation.chat.node')[0]?.component).toBe(native)
})
