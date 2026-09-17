import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { IconSettings } from '@tabler/icons-react'

/** Customize the native trigger's content; the Harness shell owns opening and focus. */
export function registerSettingsEntry(ctx: Context): void {
  ctx.slots.inject('settings.trigger', () =>
    ctx.slots.register(
      {
        name: 'settings.trigger',
        priority: -10,
        locale: 'oryh',
      },
      ({ wide, t }) => (
        <span className="oryh-settings-label" title={t('modelSettings')}>
          <IconSettings size={18} aria-hidden="true" />
          <span className={wide ? undefined : 'oryh-visually-hidden'}>{t('modelSettings')}</span>
        </span>
      ),
    ),
  )
}
