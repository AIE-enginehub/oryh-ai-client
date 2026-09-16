import {useMemo, useSyncExternalStore} from 'react'
import {createSnapshotStore} from '@deepseek-ai/dsh-client-store'
import type {ConnectionSummary} from '@oryh/ai-client-core'
import type {RecordKind} from '@oryh/ai-client-records'
import {recordColumns, recordDefaultColumns} from '@oryh/ai-client-records'
import type {ProjectColumn} from '@oryh/dsh-host/types'
import {defaultProjectColumns, projectColumnLabels} from './project-column-catalog.js'

type List = RecordKind | 'list-projects'
export function columnPreferenceScope(connection: ConnectionSummary): string {
  return JSON.stringify([connection.origin, connection.identity.tenant.id, connection.identity.user.id])
}

// Each list has its own public Harness store so saving another view cannot overwrite it.
// Persist column identifiers only; never rows, search values, drafts or credentials.
export function createColumnPreference(scope: string, list: List) {
  const defaults = list === 'list-projects' ? defaultProjectColumns : recordDefaultColumns[list]
  const allowed = list === 'list-projects' ? projectColumnLabels : recordColumns(list)
  function normalize(value: unknown): string[] {
    const columns = Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Object.hasOwn(allowed, item)))]
      : []
    if (!columns.length) return [...defaults]
    if (list === 'list-projects' && !columns.includes('name')) columns.unshift('name')
    return columns
  }
  const store = createSnapshotStore<string[]>([...defaults], {
    persist: {name: `oryh.columns.v1:${scope}:${list}`},
  })
  // Harness hydrates raw JSON. Validate before any view or Chat context observes it.
  store.set(normalize(store.getSnapshot()))
  return {getSnapshot: store.getSnapshot, subscribe: store.subscribe, set: (columns: string[]) => store.set(normalize(columns))}
}

function useColumns(scope: string, list: List) {
  const store = useMemo(() => createColumnPreference(scope, list), [scope, list])
  const columns = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return [columns, store.set] as const
}

export function useColumnPreferences(connection: ConnectionSummary) {
  const scope = columnPreferenceScope(connection)
  const [projects, setProjectColumns] = useColumns(scope, 'list-projects')
  const [sales, setSales] = useColumns(scope, 'sales-orders')
  const [inventory, setInventory] = useColumns(scope, 'inventory-items')
  const [details, setDetails] = useColumns(scope, 'inventory-item-details')
  const [shipments, setShipments] = useColumns(scope, 'shipments')
  const setters = {'sales-orders': setSales, 'inventory-items': setInventory, 'inventory-item-details': setDetails, shipments: setShipments}
  return {
    projectColumns: projects as ProjectColumn[], setProjectColumns,
    recordViewColumns: {'sales-orders': sales, 'inventory-items': inventory, 'inventory-item-details': details, shipments},
    setRecordColumns: (kind: RecordKind, columns: string[]) => setters[kind](columns),
  }
}
