/**
 * The business pages the client offers, as the page plugins registered them.
 *
 * The Host's page registry (`@oryh/ai-client-pages`) says which pages exist and who may open them;
 * this one says how they look in the menu — icon, label and order — and is filled by the page
 * plugins at load. The menu is derived from it, so a page whose plugin is not loaded has no entry.
 */
import type { PageId } from '@oryh/ai-client-pages'
import type { ReactNode } from 'react'

/** How one page presents itself in the menu and the breadcrumb. */
export interface PageRegistration {
  readonly page: PageId
  /** Menu position; lower first. Pages of one plugin keep their own order among themselves. */
  readonly order: number
  /** The menu icon, sized by the menu; any icon component, such as one from Tabler. */
  readonly icon: (props: { size?: number | string }) => ReactNode
  /** What the page is called, read at render so it follows the locale. */
  readonly label: () => string
}

export interface PagesSnapshot {
  readonly pages: readonly PageRegistration[]
}

export class ClientPages {
  #entries: PageRegistration[] = []
  #snapshot: PagesSnapshot = { pages: [] }
  readonly #listeners = new Set<() => void>()

  /** Add a page; the disposer removes it. Registering a page twice replaces the earlier entry. */
  register(registration: PageRegistration): () => void {
    this.#entries = [...this.#entries.filter(entry => entry.page !== registration.page), registration]
    this.#publish()
    return () => {
      if (!this.#entries.includes(registration)) return
      this.#entries = this.#entries.filter(entry => entry !== registration)
      this.#publish()
    }
  }

  // Bound, so `useSyncExternalStore(pages.subscribe, pages.getSnapshot)` can take them unbound.
  readonly getSnapshot = (): PagesSnapshot => this.#snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** The registration for a page, if its plugin is loaded. */
  get(page: string): PageRegistration | undefined {
    return this.#snapshot.pages.find(entry => entry.page === page)
  }

  #publish(): void {
    this.#snapshot = { pages: [...this.#entries].sort((a, b) => a.order - b.order) }
    for (const listener of [...this.#listeners]) listener()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The business pages the loaded page plugins offer, for the menu. */
    oryhClientPages: ClientPages
  }
}
