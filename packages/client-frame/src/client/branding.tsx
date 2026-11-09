import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useEffect } from 'react'
import { OryhLogo } from './logo.js'

/** Public slot occupants replace product chrome; native controls and their behavior remain owned by the shell. */
export function registerBranding(ctx: Context, managedSettings = false): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', priority: -100 }, ({ size }) => (
      <span className="oryh-brand-mark" style={{ width: size, height: size }}>
        <OryhLogo compact />
      </span>
    )),
  )
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', priority: -100 }, () => (
      <span className="oryh-brand-name">ORYH</span>
    )),
  )
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -100, locale: 'oryh' }, ({ size, t }) => (
      <span className="oryh-hero-brand">
        <span className="oryh-brand-mark" style={{ width: size, height: size }}>
          <OryhLogo compact />
        </span>
        <span>ORYH {t('assistant')}</span>
      </span>
    )),
  )
  // The upstream preview notice describes another product. Shadow its public list cell rather than
  // changing its locale namespace, forging an acknowledgement or removing the Models settings plugin.
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      { name: 'settings.onboarding', id: 'welcome-notice', priority: -100, order: -100 },
      function ProductNotice({ complete }) {
        useEffect(() => complete(), [complete])
        return null
      },
    ),
  )
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register({ name: 'settings.general.item', id: 'current-version', priority: -100, order: 100 }, () => (
      <p className="oryh-product-version">ORYH AI Client</p>
    )),
  )
  // Server-only deployment policy. Keep the public control available to desktop users.
  if (managedSettings)
    ctx.slots.inject('settings.general.item', () =>
      ctx.slots.register(
        { name: 'settings.general.item', id: 'developer-tools', priority: -100, order: 15 },
        () => null,
      ),
    )
  ctx.effect(() => {
    const previous = document.title
    const update = () => {
      document.title = ctx.locale.bind('oryh')('title')
    }
    update()
    const off = ctx.locale.subscribe(update)
    return () => {
      off()
      document.title = previous
    }
  }, 'oryh document title')
}
