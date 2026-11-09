import type { PreferenceStore } from '@oryh/ai-client-kit'

/**
 * Every kept preference of the workbench's pages — columns, filters, the page a list was on — one store
 * per stored name, held by this plugin for as long as it runs.
 *
 * A page asks for a preference by name and gets the store whoever asked first made; a list and the
 * bridge that changes its columns for the agent therefore hold the same one. Pages read through the
 * keyed hook the renderer makes over {@link source}, and write through {@link set}.
 */
export class PreferenceRegistry {
  readonly #stores = new Map<string, PreferenceStore>()
  readonly open = (name: string, make: () => PreferenceStore): void => {
    if (!this.#stores.has(name)) this.#stores.set(name, make())
  }
  readonly source = (name: string): PreferenceStore | undefined => this.#stores.get(name)
  readonly set = (name: string, next: unknown): void => this.#stores.get(name)?.set(next)
  readonly get = (name: string): unknown => this.#stores.get(name)?.getSnapshot()
}
