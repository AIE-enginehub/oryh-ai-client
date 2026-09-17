import type { ConnectionSummary } from '@oryh/ai-client-core'
import type { UserViewSummary } from '@oryh/dsh-pane/types'
import { useMemo, useSyncExternalStore } from 'react'
import { columnPreferenceScope } from './column-preferences.js'

/** A user view's page id: the frame store and the menu use it; the Host never sees it. */
export type UserViewPage = `view:${string}`
export const userViewPage = (id: string): UserViewPage => `view:${id}`
export const isUserViewPage = (page: string): page is UserViewPage => /^view:[0-9a-f-]{36}$/.test(page)

/**
 * What the page knows of a person's menu entries: a mirror of what the Host last published.
 *
 * The entries live in the Harness workspace the current session belongs to, and the Host is the only
 * writer. Nothing is persisted here — a reload asks the Host again — so there is no second copy to
 * drift. `loaded` separates "no entries" from "not heard yet", which matters on reload: a page restored
 * to `view:<id>` must wait for the list before deciding that entry is gone.
 */
interface Mirror {
  views: readonly UserViewSummary[]
  loaded: boolean
}

const empty: Mirror = { views: [], loaded: false }
/** One mirror per enterprise identity, shared by the menu and the workbench so a change shows everywhere at once. */
const mirrors = new Map<string, { state: Mirror; listeners: Set<() => void> }>()

function mirror(scope: string) {
  let m = mirrors.get(scope)
  if (!m) {
    m = { state: empty, listeners: new Set() }
    mirrors.set(scope, m)
  }
  return m
}

/**
 * Replace the mirrored entries with what the Host published.
 * @param scope - enterprise identity scope.
 * @param views - the Host's list; undefined leaves the mirror unloaded.
 */
export function publishUserViews(scope: string, views: readonly UserViewSummary[] | undefined): void {
  if (views === undefined) return
  const m = mirror(scope)
  if (m.state.loaded && JSON.stringify(m.state.views) === JSON.stringify(views)) return
  m.state = { views, loaded: true }
  for (const listener of m.listeners) listener()
}

/** The person's menu entries for this enterprise identity, live. */
export function useUserViews(connection: ConnectionSummary | undefined) {
  const scope = connection ? columnPreferenceScope(connection) : ''
  const store = useMemo(() => {
    if (!scope) return { subscribe: () => () => {}, getSnapshot: () => empty }
    const m = mirror(scope)
    return {
      subscribe: (listener: () => void) => {
        m.listeners.add(listener)
        return () => {
          m.listeners.delete(listener)
        }
      },
      getSnapshot: () => m.state,
    }
  }, [scope])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { views: state.views, loaded: state.loaded, scope }
}
