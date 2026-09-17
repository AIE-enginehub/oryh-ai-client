import type { ConnectionSummary } from '@oryh/ai-client-core'
import { canAccessPage, type PageId } from '@oryh/ai-client-pages'
import type { PaneContext, UserViewSummary } from '@oryh/dsh-pane/types'
import { IconChevronRight } from '@tabler/icons-react'
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import type { BusinessView } from './layout-store.js'
import { PageHeader } from './list-kit.js'
import { useText } from './locale.js'
import type { ClientPages } from './pages-registry.js'
import { BusinessNavigationContext, BusinessSessionContext, PaneProvider, useCommand, usePageContext } from './pane.js'
import { useOryhRemote } from './remote.js'
import { isUserViewPage, userViewPage, useUserViews } from './user-views.js'

/** What a page reports about itself to Chat: the Host's pane context, as the pages fill it in. */
export type PageContext = PaneContext

/** What the workbench hands a page plugin's entry when it renders it into `oryh.page`. */
export interface PageOwnerProps {
  connection: ConnectionSummary
  /** Whether this page is the one on screen; a hidden page keeps its state and reads again when shown. */
  active: boolean
  /** The person's menu entry this page is opened as, when it is one. */
  view?: UserViewSummary
  /** Whether the page holds unsaved work; the frame keeps the connection from changing under it. */
  onDirtyChange: (dirty: boolean) => void
  /** What the page shows, for the Host; only the page on screen is reported. */
  onContext: (value: PageContext) => void
}
/** What the workbench hands the bridges: the always-mounted pieces a page plugin adds to the pane. */
export interface BridgeOwnerProps {
  connection: ConnectionSummary
  navigate: (page: BusinessView) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One business page per key; the page plugins register theirs, the workbench renders the current one. */
    'oryh.page': { kind: 'keyed'; scope: 'root'; owner: PageOwnerProps }
    /** Always-mounted pane bridges: a page plugin's handling of the agent's commands for its pages. */
    'oryh.bridge': { kind: 'list'; scope: 'root'; owner: BridgeOwnerProps }
  }
}

/** How the workbench renders the two slots it owns; set by the slot entry that declared them. */
export interface PageSlots {
  page: (route: string, entryKey: string, owner: PageOwnerProps) => ReactNode
  bridges: (owner: BridgeOwnerProps) => ReactNode
}
export const PageSlotsContext = createContext<PageSlots | undefined>(undefined)
export const PagesContext = createContext<ClientPages | undefined>(undefined)
/** The pages the page plugins registered. */
export function usePages(): ClientPages {
  const pages = useContext(PagesContext)
  if (!pages) throw new Error('ORYH pages are not mounted')
  return pages
}

export function Workbench(props: Parameters<typeof WorkbenchContent>[0]): ReactNode {
  const { views } = useUserViews(props.connection)
  // A menu entry is only ever as open as the list it narrows: it grants nothing of its own.
  const target = isUserViewPage(props.page) ? views.find(v => userViewPage(v.id) === props.page)?.kind : props.page
  if (target !== undefined && !canAccessPage(props.connection.identity, target))
    return (
      <main className="business-content">
        <h1>此功能不可用</h1>
        <p>当前账号没有访问此功能的权限，或正在核验权限。请从左侧选择可用菜单。</p>
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
  context,
  onNavigate,
}: {
  context: PageContext | undefined
  onNavigate: (page: BusinessView) => void
}): ReactNode {
  usePageContext(context)
  useCommand(
    'navigation',
    undefined,
    command => {
      switch (command.target) {
        case 'view':
          if (!command.userViewId) return false
          onNavigate(userViewPage(command.userViewId))
          return true
        case 'page':
          if (!command.page) return false
          onNavigate(command.page)
          return true
        default:
          return false
      }
    },
    [onNavigate],
  )
  return null
}

function WorkbenchContent({
  page,
  connection,
  onDirtyChange,
  settings,
  notices,
}: {
  page: BusinessView
  connection: ConnectionSummary
  onDirtyChange: (dirty: boolean) => void
  settings: ReactNode
  notices: ReactNode
}): ReactNode {
  const t = useText()
  const navigate = useContext(BusinessNavigationContext)
  const sessionId = useContext(BusinessSessionContext)
  const remote = useOryhRemote()
  const slots = useContext(PageSlotsContext)
  const pages = usePages()
  const { views: userViews, loaded: userViewsLoaded, scope: userViewScope } = useUserViews(connection)
  const userView = isUserViewPage(page) ? userViews.find(v => userViewPage(v.id) === page) : undefined
  // The Host checks permissions against a real page, so a menu entry reports the list it narrows.
  const hostPage: PageId = userView ? userView.kind : isUserViewPage(page) ? 'my-open-todos' : (page as PageId)
  // An entry deleted elsewhere, or one from another workspace restored on reload, falls back to the
  // home page — but only once the Host's list has arrived: before that, "missing" just means "not yet".
  useEffect(() => {
    if (userViewsLoaded && isUserViewPage(page) && !userView) navigate('my-open-todos')
  }, [page, userView, userViewsLoaded, navigate])
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
  const label = isUserViewPage(page)
    ? (userView?.label ?? '')
    : page === 'settings'
      ? t('text15')
      : pages.get(page)?.label()
  /** The route a visited page renders under: the page itself, or the list a menu entry narrows. */
  const routeOf = (route: string) => {
    const view = isUserViewPage(route) ? userViews.find(v => userViewPage(v.id) === route) : undefined
    return { view, entryKey: view ? view.kind : route }
  }
  return (
    <PaneProvider sessionId={sessionId} connectionId={connection.id} page={hostPage} scope={userViewScope}>
      <div className="oryh-business">
        <WorkbenchBridge context={pageContexts[page]} onNavigate={navigate} />
        {slots?.bridges({ connection, navigate })}
        <main ref={main} className="business-content">
          {notices}
          <div className="breadcrumb">
            {t('text16')}
            <IconChevronRight size={13} /> {label ?? page}
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
                aria-label={t('text19', { value0: pages.get(entryKey)?.label() ?? entryKey })}
              >
                {slots?.page(route, entryKey, {
                  connection,
                  active,
                  ...(view ? { view } : {}),
                  onDirtyChange: dirty =>
                    setDirtyPages(current => (current[route] === dirty ? current : { ...current, [route]: dirty })),
                  onContext: value => report(route, value),
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
    </PaneProvider>
  )
}
