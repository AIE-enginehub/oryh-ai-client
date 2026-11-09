import type { OryhText } from '@oryh/ai-client-kit'
import { pageForCollection } from '@oryh/ai-client-pages'
import { IconBookmark } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { collectionIcon } from './collection-icons.js'
import type { BusinessView, FrameIdentity } from './layout-store.js'
import type { PageRegistration } from './pages-registry.js'

/**
 * The built-in pages that have a menu entry: 我的待办 and nothing else (docs/57).
 *
 * The rest of what a person sees is what they asked for: the custom pages and lists they had made, under
 * 我的视图. The other built-in pages stay loaded — Chat can still open a timesheet or an order, and a link to
 * a record still lands in the pane — they are only no longer offered here. The lists a role implies
 * (`origin: 'role'`) are not offered either: nobody asked for those. What colleagues shared
 * (`origin: 'shared'`) is, in a group of its own that says it is theirs.
 */
const MENU_PAGES: ReadonlySet<string> = new Set(['my-open-todos'])

/** Pure presentation over the loaded plugins and verified identity; no second menu registry. */
export function BusinessMenu({
  pages,
  identity,
  current,
  compact,
  navigate,
  t,
}: {
  pages: readonly PageRegistration[]
  identity: FrameIdentity | undefined
  current: BusinessView
  compact: boolean
  navigate: (page: BusinessView) => void
  t: OryhText
}) {
  const loaded = pages.filter(page => identity?.allowedPages?.includes(page.page))
  const visible = loaded.filter(page => MENU_PAGES.has(page.page))
  const ownViews = (identity?.views ?? []).filter(view => view.origin === undefined)
  const sharedViews = (identity?.views ?? []).filter(view => view.origin === 'shared')
  type MenuView = NonNullable<FrameIdentity['views']>[number]
  // A view over a page's collection wears that page's icon; one over a collection with no page wears
  // the collection's; only an entry that names no collection (made before they did) is a bookmark.
  function viewIcon(view: MenuView) {
    const source = view.collection ? pageForCollection(view.collection) : undefined
    const Icon =
      loaded.find(page => page.page === source)?.icon ??
      (view.collection ? collectionIcon(view.collection) : IconBookmark)
    return <Icon size={20} stroke={1.75} />
  }
  function item(page: BusinessView, label: string, icon: ReactNode, personal = false, hint = label) {
    return (
      <button
        key={page}
        type="button"
        className={personal ? 'oryh-user-view' : undefined}
        title={hint}
        aria-label={hint}
        aria-current={current === page ? 'page' : undefined}
        onClick={() => navigate(page)}
      >
        <span className="oryh-menu-icon" aria-hidden="true">
          {icon}
        </span>
        {!compact && <span className="oryh-menu-label">{label}</span>}
      </button>
    )
  }
  function group(id: string, label: string, children: ReactNode) {
    return (
      <div key={id} className="oryh-menu-group" role="group" aria-label={label}>
        {!compact && (
          <div className="oryh-menu-group-label" aria-hidden="true">
            {label}
          </div>
        )}
        {children}
      </div>
    )
  }
  return (
    <>
      {!!visible.length &&
        group(
          'work',
          t('menuWork'),
          visible.map(page => {
            const Icon = page.icon
            return item(page.page as BusinessView, page.label(), <Icon size={20} stroke={1.75} />)
          }),
        )}
      {!!ownViews.length &&
        group(
          'views',
          t('menuViews'),
          ownViews.map(view => item(`view:${view.id}`, view.label, viewIcon(view), true)),
        )}
      {/* A colleague's entry says whose it is where there is room to: on hover, and to a screen reader. */}
      {!!sharedViews.length &&
        group(
          'shared',
          t('menuShared'),
          sharedViews.map(view =>
            item(
              `view:${view.id}`,
              view.label,
              viewIcon(view),
              true,
              view.sharedBy ? t('menuSharedBy', { label: view.label, name: view.sharedBy }) : view.label,
            ),
          ),
        )}
    </>
  )
}
