/**
 * The ORYH workbench frame: the three-pane root, the menu, the connection screen, the pane bridge
 * and the shared page kit. The business pages themselves are page plugins: each registers into the
 * `oryh.page` slot this frame declares, and into the menu through `ctx.oryhClientPages`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { PortalMountNodeProvider } from '@fluentui/react-components'
import { TYPERT_REMOTE as CONNECTION_REMOTE } from '@oryh/dsh-connection/remote'
import { TYPERT_REMOTE as PANE_REMOTE } from '@oryh/dsh-pane/remote'
import { useState, useSyncExternalStore } from 'react'
import { App } from './app.js'
import { registerFrame } from './layout.js'
import { dictionaries, LocaleContext, type OryhKey } from './locale.js'
import { ClientPages } from './pages-registry.js'
import { BusinessNavigationContext, BusinessSessionContext } from './pane.js'
import { createFrameRemote, RemoteContext } from './remote.js'
import { registerSettingsEntry } from './settings-entry.js'
import style from './styles.css'
import { presentTheme } from './theme.js'
import { type PageSlots, PageSlotsContext, PagesContext } from './workbench.js'

export * from './kit.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    oryh: OryhKey
  }
}
export const inject = ['slots', 'remote', 'locale', 'theme']

/** Mount the frame's Remote and reversible root-scoped UI; no Session data is sent to ORYH. */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('oryh', { zh: dictionaries, en: dictionaries }), 'oryh locale')
  ctx.effect(() => {
    const sheet = document.createElement('style')
    sheet.textContent = style
    sheet.dataset.oryh = 'business'
    document.head.append(sheet)
    return () => sheet.remove()
  }, 'oryh scoped styles')
  const pages = new ClientPages()
  ctx.provide('oryhClientPages', pages)
  presentTheme(ctx)
  registerFrame(ctx, pages)
  registerSettingsEntry(ctx)
  // The frame's own namespaces; each page plugin mounts its domain's beside them.
  await ctx.remote.$mount(CONNECTION_REMOTE)
  await ctx.remote.$mount(PANE_REMOTE)
  await ctx.inject(['remote.oryh', 'remote.oryhPane'], registerUi)
}

function registerUi(ctx: Context): void {
  const remote = createFrameRemote(ctx.remote)
  const pages = ctx.oryhClientPages
  const subscribeTheme = (listener: () => void) => ctx.on('theme/change', listener)
  const getTheme = () => ctx.theme.getTheme()
  ctx.slots.inject('oryh.business', () =>
    ctx.slots.register(
      {
        name: 'oryh.business',
        locale: 'oryh',
        children: {
          'oryh.page': { kind: 'keyed', scope: 'root' },
          'oryh.bridge': { kind: 'list', scope: 'root' },
        },
      },
      function BusinessView({ t, page, navigate, onIdentity, useSessions, renderSlot }) {
        const sessionId = useSessions(state => state.current)
        const theme = useSyncExternalStore(subscribeTheme, getTheme)
        const [portal, setPortal] = useState<HTMLDivElement | null>(null)
        const slots: PageSlots = {
          page: (route, entryKey, owner) =>
            renderSlot('oryh.page', owner, {
              entryKey,
              // The route keys the page instance: two menu entries over one list are two lists.
              fallback: <p className="muted">{`${route}：此页面的插件未装载。`}</p>,
            }),
          bridges: owner => renderSlot('oryh.bridge', owner),
        }
        return (
          <div className="oryh-business-root" data-theme={theme.active.colorScheme}>
            <PortalMountNodeProvider value={portal ?? undefined}>
              <RemoteContext.Provider value={remote}>
                <LocaleContext.Provider value={t}>
                  <PagesContext.Provider value={pages}>
                    <PageSlotsContext.Provider value={slots}>
                      <BusinessSessionContext.Provider value={sessionId}>
                        <BusinessNavigationContext.Provider value={navigate}>
                          <App dark={theme.active.colorScheme === 'dark'} page={page} onIdentity={onIdentity} />
                        </BusinessNavigationContext.Provider>
                      </BusinessSessionContext.Provider>
                    </PageSlotsContext.Provider>
                  </PagesContext.Provider>
                </LocaleContext.Provider>
              </RemoteContext.Provider>
            </PortalMountNodeProvider>
            {/* The theme is repeated here on purpose. Fluent mounts dialogs under a provider it clones
          into this node; the clone copies `className` (so `.client-root` still matches) but not our
          `data-theme`, and our stylesheet is inside `@scope (.oryh-business-root)`, where an
          ancestor selector cannot reach the scope root itself. Without this attribute every token
          in a dialog falls back to the light palette under Fluent's dark-mode text. */}
            <div ref={setPortal} className="oryh-business-portals" data-theme={theme.active.colorScheme} />
          </div>
        )
      },
    ),
  )
}
