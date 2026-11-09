/**
 * The ORYH workbench frame: the three-pane root, the menu, the connection screen and the pane bridge.
 * The business pages themselves are page plugins: each registers into the `oryh.page` slot this frame
 * declares, and into the menu through `ctx.oryhClientPages`.
 *
 * A page takes nothing from this module but its types. What it needs of the frame — the Remote, the pane
 * it is bound to, the session, the words — it is handed through the slot: owner props for what the
 * workbench knows as it draws the page, the slot's inject for what the services here hold.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  type ChatActions,
  type ChatActivity,
  type OryhKey,
  type PageInject,
  waitingElsewhere,
} from '@oryh/ai-client-kit'
import { dictionaries, english } from '@oryh/ai-client-kit/dictionary'
import kitStyle from '@oryh/ai-client-kit/styles.css'
import { TYPERT_REMOTE as CONNECTION_REMOTE } from '@oryh/dsh-connection/remote'
import { TYPERT_REMOTE as PANE_REMOTE } from '@oryh/dsh-pane/remote'
import { useMemo } from 'react'
import { App } from './app.js'
import { registerBranding } from './branding.js'
import { registerFrame } from './layout.js'
import { registerModelErrors } from './model-errors.js'
import { ClientPages } from './pages-registry.js'
import { businessSessionOf, showsSubagent } from './pane.js'
import { PaneService } from './pane-service.js'
import { PreferenceRegistry } from './preferences.js'
import { createFrameRemote } from './remote.js'
import style from './styles.css'
import { presentTheme } from './theme.js'
import { MenuMirror } from './user-views.js'
import type { FrameEnv, PageSlots } from './workbench.js'

export type { BusinessView } from '@oryh/ai-client-kit'
export { ClientPages, type PageRegistration } from './pages-registry.js'
// The two slots a page plugin registers into are declared with these; exporting them is what makes the
// declaration reach a plugin that imports this entry for its types.
export type { BridgeOwnerProps, PageOwnerProps } from './workbench.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    oryh: OryhKey
  }
}
export const inject = ['slots', 'remote', 'locale', 'theme']

/** Mount the frame's Remote and reversible root-scoped UI; no Session data is sent to ORYH. */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('oryh', { zh: dictionaries, en: english }), 'oryh locale')
  ctx.effect(() => {
    const sheet = document.createElement('style')
    // The kit's controls are bundled into every plugin that draws with them; their styles are loaded once,
    // here, since this plugin is on the page before any of them.
    sheet.textContent = `${style}\n${kitStyle}`
    sheet.dataset.oryh = 'business'
    document.head.append(sheet)
    return () => sheet.remove()
  }, 'oryh scoped styles')
  const pages = new ClientPages()
  ctx.provide('oryhClientPages', pages)
  presentTheme(ctx)
  registerFrame(ctx, pages)
  registerModelErrors(ctx)
  registerBranding(
    ctx,
    document.querySelector('meta[name="oryh-managed-settings"]')?.getAttribute('content') === 'true',
  )
  // The frame's own namespaces; each page plugin mounts its domain's beside them.
  await ctx.remote.$mount(CONNECTION_REMOTE)
  await ctx.remote.$mount(PANE_REMOTE)
  await ctx.inject(['remote.oryh', 'remote.oryhPane'], registerUi)
}

function registerUi(ctx: Context): void {
  const remote = createFrameRemote(ctx.remote, () => ctx.locale.bind('oryh')('streamBroken'))
  const pages = ctx.oryhClientPages
  const menu = new MenuMirror()
  const preferences = new PreferenceRegistry()
  // The pane's binding lasts as long as this plugin does, not as long as a component stays mounted.
  const words = ctx.locale.bind('oryh')
  const pane = new PaneService(remote, menu, words)
  ctx.effect(() => () => pane.dispose(), 'oryh pane')
  const sources = { pane: pane.stream, paneLocal: pane.local }
  // What every page and bridge is handed beside its owner props.
  const face: PageInject = {
    remote,
    local: { getSnapshot: pane.local.getSnapshot, setContext: pane.local.setContext, ack: pane.local.ack },
    prefs: { open: preferences.open, set: preferences.set, get: preferences.get },
    hooks: sources,
  }
  // What the frame's own entry reads of this plugin's world beside the pane: the theme, and the mirrored
  // menu by enterprise identity. Sources only; the renderer makes the hooks.
  const theme = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: (listener: () => void) => ctx.on('theme/change', listener),
  }
  // Starting a session and opening one are Harness's own, through its workspace navigation; where the
  // workspace is not there, a page is told so.
  const startSession = (): boolean => {
    const workspace = ctx.get('uiWorkspace')
    if (!workspace) return false
    workspace.startSession()
    return true
  }
  const openSession = (id: string): void => {
    const workspace = ctx.get('uiWorkspace')
    workspace?.openSession(id as Parameters<typeof workspace.openSession>[0])
  }
  const pageLabel = (page: string): string | undefined => pages.get(page)?.label()
  ctx.slots.inject('oryh.business', () =>
    ctx.slots.register(
      {
        name: 'oryh.business',
        locale: 'oryh',
        // Root-scoped on purpose: Harness draws a session-scoped entry afresh when its session changes,
        // and a page holds work — a half-written form, a narrowed list — that has to outlive a change
        // of conversation. The session reaches a page as a prop instead.
        children: {
          'oryh.page': { kind: 'keyed', scope: 'root', inject: face },
          'oryh.bridge': { kind: 'list', scope: 'root', inject: face },
        },
        inject: () => ({
          hooks: { ...sources, theme },
          keyedHooks: { menu: menu.source, preference: preferences.source },
        }),
      },
      function BusinessView({
        t,
        page,
        navigate,
        onIdentity,
        showChat,
        useSessions,
        useSessionStatus,
        usePane,
        usePaneLocal,
        useTheme,
        useMenu,
        usePreference,
        renderSlot,
      }) {
        // The session the main view holds — which is what the pane binds to. Harness stopped naming one
        // `current` on the list; a session is the main one while the main view retains it, the way its own
        // document title finds it. A subagent's conversation shown there leaves the pane on its Chat.
        const sessionId = useSessions(businessSessionOf)
        const onSubagent = useSessions(showsSubagent)
        // Harness reads a ready, empty list as "truly no sessions": none is about to be restored.
        const noSessions = useSessions(state => state.phase === 'ready' && state.ids.length === 0)
        // What that session's agent is doing, for the pages: at work, waiting on the person, or neither.
        const activity = useSessionStatus((statuses): ChatActivity => {
          const status = [...statuses].find(([id]) => String(id) === sessionId)?.[1]
          if (status === undefined) return 'none'
          return status.pendingInteraction !== undefined ? 'waiting' : status.running ? 'running' : 'idle'
        })
        // The conversation the main view itself holds, which is a run's own while someone reads one.
        const mainSession = useSessions(
          state => Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id,
        )
        // And a conversation not on show whose agent waits on the person, so the page can say so.
        const elsewhere = useSessionStatus(statuses => waitingElsewhere(statuses, [sessionId, mainSession]))
        const colorScheme = useTheme(current => current.active.colorScheme)
        // What a page may do to Chat itself: start a session for someone who has none, and bring Chat
        // forward.
        //
        // Brought forward, Chat shows the conversation the pane is bound to. Someone reading a review's
        // own conversation who then asked from a page had their question go to the Chat it belongs to,
        // as it must, while the review stayed on show: asked, and answered where nobody was looking.
        const chat = useMemo<ChatActions>(
          () => ({
            startSession,
            showChat: () => {
              if (sessionId !== undefined && onSubagent) openSession(sessionId)
              showChat()
            },
            showSession: id => {
              openSession(id)
              showChat()
            },
          }),
          [showChat, sessionId, onSubagent],
        )
        const slots = useMemo<PageSlots>(
          () => ({
            page: (route, entryKey, owner) =>
              renderSlot('oryh.page', owner, {
                entryKey,
                // The route keys the page instance: two menu entries over one list are two lists.
                fallback: <p className="muted">{t('pageNotLoaded', { route })}</p>,
              }),
            bridges: owner => renderSlot('oryh.bridge', owner),
          }),
          [renderSlot, t],
        )
        // Everything the workbench needs of this entry, as one prop: nothing below reads a React context.
        const env = useMemo<FrameEnv>(
          () => ({
            remote,
            t,
            slots,
            pageLabel,
            sessionId,
            noSessions,
            navigate,
            chat,
            activity,
            elsewhere,
            pane,
            usePane,
            usePaneLocal,
            useMenu,
            prefs: face.prefs,
            usePreference,
          }),
          [
            t,
            slots,
            sessionId,
            noSessions,
            navigate,
            chat,
            activity,
            elsewhere,
            usePane,
            usePaneLocal,
            useMenu,
            usePreference,
          ],
        )
        return (
          <div className="oryh-business-root" data-theme={colorScheme}>
            <App env={env} dark={colorScheme === 'dark'} page={page} onIdentity={onIdentity} />
          </div>
        )
      },
    ),
  )
}
