import { BusinessNavigationContext } from './chat-navigation.js'
import { BusinessSessionContext } from './todo-chat.js'
/** ORYH business views mounted into public Harness slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { useState, useSyncExternalStore } from 'react'
import { TYPERT_REMOTE } from '@oryh/dsh-host/remote'
import { PortalMountNodeProvider } from '@fluentui/react-components'
import { App } from './app.js'
import { createOryhRemote, RemoteContext } from './remote.js'
import style from './styles.css'
import { registerFrame } from './layout.js'
import { presentTheme } from './theme.js'
import { registerSettingsEntry } from './settings-entry.js'

import { LocaleContext, dictionaries, type OryhKey } from './locale.js'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { oryh: OryhKey } }
export const inject = ['slots', 'remote', 'locale', 'theme']

/** Mount generated Remote and reversible root-scoped UI; no Session data is sent to ORYH. */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('oryh', { zh: dictionaries, en: dictionaries }), 'oryh locale')
  ctx.effect(() => {
    const sheet = document.createElement('style')
    sheet.textContent = style
    sheet.dataset.oryh = 'business'
    document.head.append(sheet)
    return () => sheet.remove()
  }, 'oryh scoped styles')
  presentTheme(ctx)
  registerFrame(ctx)
  registerSettingsEntry(ctx)
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryh'], registerUi)
}

function registerUi(ctx: Context): void {
  const remote = createOryhRemote(ctx.remote)
  const subscribeTheme = (listener: () => void) => ctx.on('theme/change', listener)
  const getTheme = () => ctx.theme.getTheme()
  ctx.slots.inject('oryh.business', () => ctx.slots.register({
    name: 'oryh.business', locale: 'oryh',
  }, function BusinessView({ t, page, navigate, onIdentity, useSessions }) {
    const sessionId = useSessions(state => state.current)
    const theme = useSyncExternalStore(subscribeTheme, getTheme)
    const [portal, setPortal] = useState<HTMLDivElement | null>(null)
    return <div className="oryh-business-root" data-theme={theme.active.colorScheme}>
      <PortalMountNodeProvider value={portal ?? undefined}><RemoteContext.Provider value={remote}><LocaleContext.Provider value={t}><BusinessSessionContext.Provider value={sessionId}><BusinessNavigationContext.Provider value={navigate}><App dark={theme.active.colorScheme === 'dark'} page={page} onIdentity={onIdentity}/></BusinessNavigationContext.Provider></BusinessSessionContext.Provider></LocaleContext.Provider></RemoteContext.Provider></PortalMountNodeProvider>
      {/* The theme is repeated here on purpose. Fluent mounts dialogs under a provider it clones
          into this node; the clone copies `className` (so `.client-root` still matches) but not our
          `data-theme`, and our stylesheet is inside `@scope (.oryh-business-root)`, where an
          ancestor selector cannot reach the scope root itself. Without this attribute every token
          in a dialog falls back to the light palette under Fluent's dark-mode text. */}
      <div ref={setPortal} className="oryh-business-portals" data-theme={theme.active.colorScheme}/>
    </div>
  }))
}
