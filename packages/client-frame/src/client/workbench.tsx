import type { ConnectionSummary } from '@oryh/ai-client-core'
import {
  type BridgeOwnerProps,
  type BusinessView,
  type ChatActions,
  type ChatActivity,
  ChatActivityNote,
  columnPreferenceScope,
  type FrameRemote,
  type FrameShare,
  noUserViews,
  type OryhText,
  type PageContext,
  type PageFace,
  PageHeader,
  type PageInject,
  type PageOwnerProps,
  type PaneLocalState,
  type PaneStreamState,
  type SelectHook,
  type UserViews,
  useCommand,
  usePageContext,
} from '@oryh/ai-client-kit'
import {
  allowedPages,
  canAccessPage,
  listPageForCollection,
  offersPage,
  type PageId,
  type PageIdentity,
  pageForCollection,
} from '@oryh/ai-client-pages'
import { IconChevronRight } from '@tabler/icons-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { ChatRecordLinks } from './chat-links.js'
import { usePaneTarget } from './pane.js'
import type { PaneService } from './pane-service.js'
import { isUserViewPage, userViewPage, viewGranted } from './user-views.js'

export type { BridgeOwnerProps, PageContext, PageOwnerProps }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One business page per key; the page plugins register theirs, the workbench renders the current one. */
    'oryh.page': { kind: 'keyed'; scope: 'root'; owner: PageOwnerProps; inject: PageInject }
    /** Always-mounted pane bridges: a page plugin's handling of the agent's commands for its pages. */
    'oryh.bridge': { kind: 'list'; scope: 'root'; owner: BridgeOwnerProps; inject: PageInject }
  }
}

/** How the workbench renders the two slots it owns; set by the slot entry that declared them. */
export interface PageSlots {
  page: (route: string, entryKey: string, owner: PageOwnerProps) => ReactNode
  bridges: (owner: BridgeOwnerProps) => ReactNode
}

/**
 * What the frame's entry is drawn with, handed down as one prop: there is no React context between the
 * entry and the workbench. The hooks are the renderer's, made over this plugin's own sources.
 */
export interface FrameEnv {
  readonly remote: FrameRemote
  readonly t: OryhText
  readonly slots: PageSlots
  /** What a page is called in the menu, where a page plugin registered one. */
  readonly pageLabel: (page: string) => string | undefined
  /** The Chat session the pane binds to; undefined when no session is open. */
  readonly sessionId: string | undefined
  /** The Host's session list has arrived holding no session at all, so none is about to be restored. */
  readonly noSessions: boolean
  readonly navigate: (page: BusinessView, reveal?: boolean) => void
  readonly chat: ChatActions
  readonly activity: ChatActivity
  /** A conversation other than the one on show whose agent waits on the person. */
  readonly elsewhere: string | undefined
  readonly pane: PaneService
  readonly usePane: SelectHook<PaneStreamState>
  readonly usePaneLocal: SelectHook<PaneLocalState>
  /** The mirrored menu of one enterprise identity; undefined for a scope nobody has asked about. */
  readonly useMenu: (scope: string) => UserViews | undefined
  /** The frame's kept preferences, and the renderer's keyed hook over them. */
  readonly prefs: PageInject['prefs']
  readonly usePreference: (name: string) => unknown
}

/**
 * Where a person is taken from a page restored for them that cannot be shown: the first page their menu
 * offers. Settings, which every account may open, only if it offers none.
 * @param identity - the verified identity.
 */
function homePage(identity: PageIdentity): Exclude<PageId, 'collection'> {
  return allowedPages(identity).find(page => page !== 'settings' && page !== 'collection') ?? 'settings'
}

export function Workbench(props: Parameters<typeof WorkbenchContent>[0]): ReactNode {
  const { navigate } = props.env
  const { views } = props.env.useMenu(columnPreferenceScope(props.connection)) ?? noUserViews
  const { identity } = props.connection
  // A menu entry grants nothing of its own: what it lists is read from ORYH as this person.
  const entry = isUserViewPage(props.page) ? views.find(v => userViewPage(v.id) === props.page) : undefined
  const target = entry ? pageForCollection(entry.collection) : isUserViewPage(props.page) ? undefined : props.page
  const denied =
    (entry !== undefined && !viewGranted(identity, entry)) ||
    (target !== undefined && !canAccessPage(identity, target)) ||
    // A page this client no longer has, restored from before it went.
    (entry === undefined && target !== undefined && !offersPage(target))
  const home = homePage(identity)
  // The page restored on load can be one this account may not open: a permission revoked since. Nobody
  // chose to be there, so the person is taken home, as with a menu entry that no longer exists. The app
  // renders this only once permissions are verified.
  useEffect(() => {
    // Nobody asked to see it either: on a narrow screen the person stays where they are.
    if (denied && home !== props.page) navigate(home, false)
  }, [denied, home, props.page, navigate])
  if (denied)
    return (
      <main className="business-content">
        <h1>{props.env.t('pageUnavailable')}</h1>
        <p>{props.env.t('pageUnavailableHint')}</p>
      </main>
    )
  return <WorkbenchContent {...props} />
}

/**
 * The workbench's own part of the pane bridge: it reports the current page's context and opens a
 * page or a person's menu entry when the agent asks. Everything a page has to answer for itself is
 * the page plugin's bridge's to handle.
 */
function WorkbenchBridge({
  face,
  context,
  onNavigate,
}: {
  face: PageFace
  context: PageContext | undefined
  onNavigate: (page: BusinessView, reveal?: boolean) => void
}): ReactNode {
  usePageContext(face, context)
  useCommand(
    face,
    'navigation',
    undefined,
    command => {
      switch (command.target) {
        case 'view':
          if (!command.userViewId) return false
          onNavigate(userViewPage(command.userViewId), command.reveal === true)
          return true
        case 'page':
          // `collection` is where a menu entry is rendered, not a page a person is ever on: a person
          // is on the entry itself, and the entry names what shows it.
          if (!command.page || command.page === 'collection') return false
          onNavigate(command.page, command.reveal === true)
          return true
        case 'filters':
          // A list narrowed as the agent read it: the list's page applies the conditions and answers for
          // them; the workbench only gets there. On the page already showing there is nowhere to go.
          if (command.page && command.page !== 'collection') onNavigate(command.page, command.reveal === true)
          return false
        case 'record':
          // The page that shows the record opens it and answers for it; the workbench only gets there:
          // to a built-in page, or to the menu entry that lists the record's collection.
          if (command.page && command.page !== 'collection') onNavigate(command.page, command.reveal === true)
          else if (command.userViewId) onNavigate(userViewPage(command.userViewId), command.reveal === true)
          return false
        default:
          return false
      }
    },
    [onNavigate],
  )
  return null
}

function WorkbenchContent({
  env,
  page,
  connection,
  onDirtyChange,
  settings,
  notices,
}: {
  env: FrameEnv
  page: BusinessView
  connection: ConnectionSummary
  onDirtyChange: (dirty: boolean) => void
  settings: ReactNode
  notices: ReactNode
}): ReactNode {
  const { t, navigate, sessionId, noSessions, chat, activity, remote, slots } = env
  const userViewScope = columnPreferenceScope(connection)
  const { views: userViews, loaded: userViewsLoaded, sharing = false } = env.useMenu(userViewScope) ?? noUserViews
  const userView = isUserViewPage(page) ? userViews.find(v => userViewPage(v.id) === page) : undefined
  const home = homePage(connection.identity)
  // What every page and bridge is told of the workbench as it is drawn; the rest reaches them through
  // the slot's own inject (index.tsx). The frame's own pieces below take the two together, as a page does.
  const frame = useMemo<FrameShare>(
    () => ({
      sessionId,
      navigate,
      chat,
      activity,
      menu: { views: userViews, loaded: userViewsLoaded, sharing },
      t,
      usePreference: env.usePreference,
    }),
    [sessionId, navigate, chat, activity, userViews, userViewsLoaded, sharing, t, env.usePreference],
  )
  const face = useMemo<PageFace>(
    () => ({
      connection,
      frame,
      remote,
      prefs: env.prefs,
      local: env.pane.local,
      usePane: env.usePane,
      usePaneLocal: env.usePaneLocal,
    }),
    [connection, frame, remote, env.prefs, env.pane, env.usePane, env.usePaneLocal],
  )
  // The Host checks permissions against a real page, so a menu entry reports the list it narrows.
  const hostPage: PageId = userView
    ? listPageForCollection(userView.collection)
    : isUserViewPage(page)
      ? home
      : (page as PageId)
  // An entry deleted elsewhere, one from another workspace, or one gone with the workspace that held it
  // falls back to the first page of this person's menu, as a page they may not open does — but only once
  // the menu has arrived: before that, "missing" just means "not yet".
  useEffect(() => {
    if (userViewsLoaded && isUserViewPage(page) && !userView) navigate(home, false)
  }, [page, userView, userViewsLoaded, home, navigate])
  // ORYH hands an agent its skills on approval and expects it to re-sync, because a tenant admin
  // can redefine business logic at any time. The Host compares the server manifest first, so this
  // is a cheap no-op once installed. Failure is deliberately silent: the workbench still works
  // without skills, and a blocking error here would be worse than a Chat that knows less.
  useEffect(() => {
    void remote.skillSync(connection.id).catch(() => {})
  }, [remote, connection.id])
  // Pages stay mounted once visited, hidden when not on screen, so unsaved work survives a detour
  // through another page. Which pages exist is the plugins' business; which are open is this list.
  const [visited, setVisited] = useState<string[]>(() => (page === 'settings' ? [] : [page]))
  useEffect(() => {
    if (page !== 'settings') setVisited(current => (current.includes(page) ? current : [...current, page]))
  }, [page])
  const [dirtyPages, setDirtyPages] = useState<Record<string, boolean>>({})
  const dirtyKey = JSON.stringify(dirtyPages)
  useEffect(
    () => onDirtyChange(Object.values(dirtyPages).some(Boolean)),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the map, serialised.
    [dirtyKey, onDirtyChange],
  )
  usePaneTarget(env.pane, { sessionId, noSessions, connectionId: connection.id, page: hostPage, scope: userViewScope })
  const main = useRef<HTMLElement>(null)
  useEffect(() => {
    const seat = main.current?.closest<HTMLElement>('.oryh-business-seat')
    if (seat) seat.scrollTop = 0
  }, [page])
  const [pageContexts, setPageContexts] = useState<Record<string, PageContext>>({})
  function report(id: string, value: PageContext) {
    setPageContexts(current =>
      JSON.stringify(current[id]) === JSON.stringify(value) ? current : { ...current, [id]: value },
    )
  }
  const company = connection.identity.tenant.name ?? connection.identity.tenant.slug
  const label = isUserViewPage(page) ? (userView?.label ?? '') : page === 'settings' ? t('text15') : env.pageLabel(page)
  /** The route a visited page renders under: the page itself, or the list a menu entry narrows. */
  const routeOf = (route: string) => {
    const view = isUserViewPage(route) ? userViews.find(v => userViewPage(v.id) === route) : undefined
    return { view, entryKey: view ? listPageForCollection(view.collection) : route }
  }
  return (
    <>
      <div className="oryh-business">
        <WorkbenchBridge face={face} context={pageContexts[page]} onNavigate={navigate} />
        <ChatRecordLinks face={face} />
        {slots?.bridges({ connection, navigate, frame })}
        <main ref={main} className="business-content">
          {notices}
          <div className="breadcrumb">
            {t('text16')}
            <IconChevronRight size={13} /> {label ?? page}
            <ChatActivityNote t={t} activity={activity} chat={chat} elsewhere={env.elsewhere} />
          </div>
          {page === 'settings' && <PageHeader title={t('text15')} note={t('text18')} />}
          {visited.map(route => {
            const { view, entryKey } = routeOf(route)
            // A menu entry whose list is not on offer, or a page whose plugin is not loaded, renders nothing.
            if (isUserViewPage(route) && !view) return null
            if (!canAccessPage(connection.identity, entryKey as PageId)) return null
            const active = route === page
            return (
              <section
                key={route}
                hidden={!active}
                aria-label={t('text19', { value0: env.pageLabel(entryKey) ?? entryKey })}
              >
                {slots?.page(route, entryKey, {
                  connection,
                  active,
                  ...(view ? { view } : {}),
                  onDirtyChange: dirty =>
                    setDirtyPages(current => (current[route] === dirty ? current : { ...current, [route]: dirty })),
                  onContext: value => report(route, value),
                  frame,
                })}
              </section>
            )
          })}
          {page === 'settings' && (
            <section className="settings-page">
              <div className="surface">
                <dl className="detail-grid">
                  <dt>{t('text23')}</dt>
                  <dd>{company}</dd>
                  <dt>{t('text24')}</dt>
                  <dd>{connection.identity.user.email}</dd>
                  <dt>{t('text25')}</dt>
                  <dd>{connection.origin}</dd>
                </dl>
                {settings}
              </div>
            </section>
          )}
        </main>
      </div>
    </>
  )
}
