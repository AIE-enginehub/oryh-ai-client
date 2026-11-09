import { noUserViews, type UserViews } from '@oryh/ai-client-kit'
import type { UserViewSummary } from '@oryh/dsh-pane/types'

export { isUserViewPage, type UserViewPage, userViewPage, viewGranted } from '@oryh/ai-client-kit'

/**
 * What the page knows of a person's menu entries: a mirror of what the Host last published.
 *
 * The entries live in the Harness workspace the current session belongs to, and the Host is the only
 * writer. Nothing is persisted here — a reload asks the Host again — so there is no second copy to
 * drift. `loaded` separates "no entries" from "not heard yet", which matters on reload: a page restored
 * to `view:<id>` must wait for the list before deciding that entry is gone.
 *
 * One per plugin, made when it starts: one mirror per enterprise identity, read by the menu and the
 * workbench through a hook the renderer makes, so a change shows everywhere at once.
 */
export class MenuMirror {
  readonly #mirrors = new Map<string, { state: UserViews; listeners: Set<() => void> }>()
  readonly #sources = new Map<string, { getSnapshot(): UserViews; subscribe(listener: () => void): () => void }>()

  #mirror(scope: string) {
    let m = this.#mirrors.get(scope)
    if (!m) {
      m = { state: noUserViews, listeners: new Set() }
      this.#mirrors.set(scope, m)
    }
    return m
  }

  /**
   * The entries for one enterprise identity, as a source that stays the same object for that identity.
   * @param scope - enterprise identity scope; the empty scope has no entries and never will.
   */
  readonly source = (scope: string) => {
    let source = this.#sources.get(scope)
    if (!source) {
      const m = this.#mirror(scope)
      source = {
        getSnapshot: () => m.state,
        subscribe: listener => {
          m.listeners.add(listener)
          return () => {
            m.listeners.delete(listener)
          }
        },
      }
      this.#sources.set(scope, source)
    }
    return source
  }

  /**
   * Replace the mirrored entries with what the Host published.
   * @param scope - enterprise identity scope.
   * @param views - the Host's list; undefined leaves the mirror unloaded.
   * @param sharing - whether the deployment lets colleagues share entries with each other.
   */
  publish(scope: string, views: readonly UserViewSummary[] | undefined, sharing = false): void {
    if (views === undefined || !scope) return
    const m = this.#mirror(scope)
    if (
      m.state.loaded &&
      (m.state.sharing === true) === sharing &&
      JSON.stringify(m.state.views) === JSON.stringify(views)
    )
      return
    m.state = { views, loaded: true, ...(sharing ? { sharing } : {}) }
    for (const listener of m.listeners) listener()
  }

  /**
   * Show what the role implies while no session has published the whole menu.
   *
   * Partial while a session may still come: the person's own entries live in a session's workspace and
   * are not among these, so the mirror stays "not heard yet" — a page restored to one of them keeps
   * waiting instead of being sent home. Where the Host holds no session at all, none is coming — a fresh
   * workspace has none until the person first writes in Chat — and these are the whole menu until then;
   * waiting for the rest would leave a restored page blank for good. A whole list a session already
   * published is not replaced.
   * @param scope - enterprise identity scope.
   * @param views - the role's entries.
   * @param whole - the Host holds no session to publish the rest.
   */
  publishRole(scope: string, views: readonly UserViewSummary[], whole = false): void {
    if (!scope) return
    const m = this.#mirror(scope)
    if (m.state.loaded || (!whole && JSON.stringify(m.state.views) === JSON.stringify(views))) return
    m.state = { views, loaded: whole }
    for (const listener of m.listeners) listener()
  }
}
