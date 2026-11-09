import type { Context } from '@deepseek-ai/cordis'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronUp, IconPlugConnected, IconSettings, IconUserCircle } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { BusinessView, FrameIdentity } from './layout-store.js'

/** Replace the optional launcher, keeping the native settings dialog, shortcuts and focus handling. */
export function registerSettingsEntry(
  ctx: Context,
  identity: HostObservable<FrameIdentity | undefined>,
  navigate: (page: BusinessView) => void,
): () => void {
  return ctx.slots.inject('settings.launcher', () =>
    ctx.slots.register(
      {
        name: 'settings.launcher',
        priority: -100,
        locale: 'oryh',
        inject: () => ({ hooks: { identity } }),
      },
      function AccountLauncher({ wide, t, openSettings, settingsOpen, settingsShortcut, useIdentity }) {
        const person = useIdentity(value => value)
        const [open, setOpen] = useState(false)
        useEffect(() => setOpen(false), [person?.scope, settingsOpen])
        return (
          <Menu
            className="oryh-account-menu"
            open={open}
            onClose={() => setOpen(false)}
            side="top"
            portal
            autoFocus
            items={[
              {
                id: 'settings',
                label: t('modelSettings'),
                icon: <IconSettings size={18} />,
                ...(settingsShortcut ? { shortcut: settingsShortcut } : {}),
              },
              { id: 'connection', label: t('connection'), icon: <IconPlugConnected size={18} /> },
              ...(person?.switchAccount ? [{ id: 'switch', label: t('switchAccount') }] : []),
              ...(person?.signOut ? [{ id: 'sign-out', label: t('signOut') }] : []),
            ]}
            onSelect={id => {
              setOpen(false)
              if (id === 'settings') openSettings()
              if (id === 'connection') navigate('settings')
              if (id === 'switch') person?.switchAccount?.()
              if (id === 'sign-out') person?.signOut?.()
            }}
            anchor={
              <button
                type="button"
                className="oryh-account-trigger"
                aria-label={person ? `${person.email} · ${t('accountSettings')}` : t('modelSettings')}
                title={person ? `${person.email}\n${person.company}` : t('modelSettings')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
              >
                {person ? (
                  <IconUserCircle size={22} aria-hidden="true" />
                ) : (
                  <IconSettings size={20} aria-hidden="true" />
                )}
                <span className={wide ? 'oryh-account-copy' : 'oryh-visually-hidden'}>
                  <span>{person?.email ?? t('modelSettings')}</span>
                  {person && <small>{person.company}</small>}
                </span>
                {wide && <IconChevronUp size={14} aria-hidden="true" />}
              </button>
            }
          />
        )
      },
    ),
  )
}
