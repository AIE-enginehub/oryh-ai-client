import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { userScope } from '@oryh/ai-client-foundation'
import { useMemo, useSyncExternalStore } from 'react'

/** Column preferences are per enterprise identity: the same person at two companies keeps two sets. */
export function columnPreferenceScope(connection: ConnectionSummary): string {
  return userScope(connection)
}

/** What a list's columns may be, and what they are until the person chooses. */
export interface ColumnCatalog {
  /** Column ids to their labels; anything else stored is dropped. */
  readonly allowed: Readonly<Record<string, string>>
  readonly defaults: readonly string[]
  /** A column that is always shown first, such as a record's name. */
  readonly required?: string
}

// Each list has its own public Harness store so saving another view cannot overwrite it.
// Persist column identifiers only; never rows, search values, drafts or credentials.
// This reads the stored value afresh; live code shares one store per list through columnPreference.
export function createColumnPreference(scope: string, list: string, catalog: ColumnCatalog) {
  function normalize(value: unknown): string[] {
    const columns = Array.isArray(value)
      ? [
          ...new Set(
            value.filter((item): item is string => typeof item === 'string' && Object.hasOwn(catalog.allowed, item)),
          ),
        ]
      : []
    if (!columns.length) return [...catalog.defaults]
    if (catalog.required !== undefined && !columns.includes(catalog.required)) columns.unshift(catalog.required)
    return columns
  }
  const store = createSnapshotStore<string[]>([...catalog.defaults], {
    persist: { name: `oryh.columns.v1:${scope}:${list}` },
  })
  // Harness hydrates raw JSON. Validate before any view or Chat context observes it.
  store.set(normalize(store.getSnapshot()))
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    set: (columns: string[]) => store.set(normalize(columns)),
  }
}

type ColumnPreference = ReturnType<typeof createColumnPreference>
const live = new Map<string, ColumnPreference>()

/**
 * The one store for a list's columns under an enterprise identity.
 *
 * A column change the agent asks for is written by the page plugin's bridge and read by the list,
 * and both must hold this same store. Two stores over one persisted key never tell each other: the
 * list kept showing and reporting its old columns, so Chat waited for a confirmation that never came.
 * @param scope - the enterprise identity, from {@link columnPreferenceScope}.
 * @param list - the list's id.
 * @param catalog - that list's columns; the first one given for a list is the one kept.
 * @returns the shared store.
 */
export function columnPreference(scope: string, list: string, catalog: ColumnCatalog): ColumnPreference {
  const key = JSON.stringify([scope, list])
  let store = live.get(key)
  if (store === undefined) {
    store = createColumnPreference(scope, list, catalog)
    live.set(key, store)
  }
  return store
}

/** One list's columns for this enterprise identity, live. */
export function useColumnPreference(connection: ConnectionSummary, list: string, catalog: ColumnCatalog) {
  const scope = columnPreferenceScope(connection)
  // Not keyed on the catalog: callers build it per render, and the store for a list does not change with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const store = useMemo(() => columnPreference(scope, list, catalog), [scope, list])
  const columns = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return [columns, store.set] as const
}
