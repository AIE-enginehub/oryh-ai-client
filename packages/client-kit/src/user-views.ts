/** A person's menu entries, as a page sees them. The frame mirrors what the Host published and hands it on. */
import type { UserViewSummary } from '@oryh/dsh-pane/types'

/** A user view's page id: the frame store and the menu use it; the Host never sees it. */
export type UserViewPage = `view:${string}`
export const userViewPage = (id: string): UserViewPage => `view:${id}`
export const isUserViewPage = (page: string): page is UserViewPage => /^view:[0-9a-f-]{36}$/.test(page)

/**
 * What the page knows of a person's menu entries. `loaded` separates "no entries" from "not heard yet",
 * which matters on reload: a page restored to `view:<id>` must wait for the list before deciding that
 * entry is gone.
 */
export interface UserViews {
  readonly views: readonly UserViewSummary[]
  readonly loaded: boolean
  /** Whether this deployment lets colleagues share menu entries with each other; the desktop does not. */
  readonly sharing?: boolean
}
export const noUserViews: UserViews = { views: [], loaded: false }

/**
 * Whether the person may use a menu entry now. An entry their role implies lasts only while they hold a
 * grant that implies it: the Host keeps a role's menu for a while, and a grant taken away in ORYH must
 * take its entry with it at once, as it does the moment the page re-verifies who the person is.
 * @param identity - the verified identity.
 * @param view - the entry.
 */
export function viewGranted(
  identity: { readonly permissions?: readonly string[] },
  view: Pick<UserViewSummary, 'origin' | 'grants'>,
): boolean {
  if (view.origin !== 'role' || !view.grants?.length) return true
  const held = new Set(identity.permissions ?? [])
  return view.grants.some(grant => held.has(grant))
}
