import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { userScope } from '@oryh/ai-client-foundation'
import { useCallback } from 'react'

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

/** What the column hooks read of a page's face; `view-preferences` says what each part is. */
interface ColumnFace {
  connection: ConnectionSummary
  prefs: {
    open(name: string, make: () => ReturnType<typeof createColumnPreference>): void
    set(name: string, next: unknown): void
    get(name: string): unknown
  }
  frame: { usePreference: (name: string) => unknown }
}

/** Open the one store for a list's columns under the page's enterprise identity, and name it. */
function columnsOf(face: ColumnFace, list: string, catalog: ColumnCatalog): string {
  const scope = columnPreferenceScope(face.connection)
  const name = `oryh.columns.v1:${scope}:${list}`
  // The first catalog given for a list is the one kept: callers build it per render, and it does not change.
  face.prefs.open(name, () => createColumnPreference(scope, list, catalog))
  return name
}

/**
 * Set a list's columns from outside the list: a column change the agent asks for is written by the page
 * plugin's bridge and read by the list. Both reach the same store through the frame's registry — two
 * stores over one persisted key never told each other, the list kept showing and reporting its old
 * columns, and Chat waited for a confirmation that never came.
 * @param face - what the bridge's slot handed it.
 * @param list - the list's id.
 * @param catalog - that list's columns.
 * @param columns - the columns to show; what the catalog does not allow is dropped.
 */
export function setColumnPreference(face: ColumnFace, list: string, catalog: ColumnCatalog, columns: string[]): void {
  face.prefs.set(columnsOf(face, list, catalog), columns)
}

/** One list's columns for the page's enterprise identity, live. */
export function useColumnPreference(face: ColumnFace, list: string, catalog: ColumnCatalog) {
  const name = columnsOf(face, list, catalog)
  const { prefs } = face
  const columns = (face.frame.usePreference(name) ?? prefs.get(name)) as string[]
  const set = useCallback((next: string[]) => prefs.set(name, next), [prefs, name])
  return [columns, set] as const
}
