import { type ColumnCatalog, type OryhKey } from '@oryh/ai-client-kit'
import { type RecordKind, recordColumns, recordDefaultColumns, recordSpecs } from '@oryh/ai-client-records'

export const isRecordKind = (value: string): value is RecordKind => Object.hasOwn(recordSpecs, value)
/** What each list is called, as a key in the frame's dictionary. */
export const recordPageLabels: Record<RecordKind, OryhKey> = {
  'sales-orders': 'salesOrders',
  'inventory-items': 'inventoryItems',
  'inventory-item-details': 'inventoryDetails',
  shipments: 'shipments',
}
/**
 * One list's columns, for the preference store. A menu entry over the list starts with the columns it was
 * made with, in their order, where the list can show them; the list's own defaults are for the rest.
 */
export function recordCatalog(kind: RecordKind, view?: { display?: { columns: { field: string }[] } }): ColumnCatalog {
  const allowed = recordColumns(kind)
  const made = (view?.display?.columns ?? []).map(c => c.field).filter(field => Object.hasOwn(allowed, field))
  return { allowed, defaults: made.length ? made : recordDefaultColumns[kind] }
}

/** Keep built-in preferences stable; each saved view owns an independent display. */
export function recordViewKey(kind: RecordKind, viewId?: string): string {
  return viewId ? `view:${viewId}` : kind
}

/** A menu entry's own columns, for the preference store: what it was made with, all shown by default. */
export function collectionCatalog(view: { display?: { columns: { field: string; label: string }[] } }): ColumnCatalog {
  const columns = view.display?.columns ?? []
  return { allowed: Object.fromEntries(columns.map(c => [c.field, c.label])), defaults: columns.map(c => c.field) }
}

/**
 * What a row is called where it has to be told from its neighbours: on its open button and in the
 * question 「问 AI」 puts about it. A title of its own is enough. One it shares with other rows on the page
 * is not — a list titled by a reason or a status has many rows of one title — and one that is only the
 * record's id names nothing to a person; then the first thing the row shows that says something else is
 * added.
 * @param row - the row.
 * @param cells - what the row shows, in column order.
 * @param shared - the titles more than one row on the page has.
 */
export function rowName(
  row: { id: string; title: string },
  cells: readonly string[],
  shared: ReadonlySet<string>,
): string {
  const title = row.title && row.title !== row.id ? row.title : ''
  if (title && !shared.has(title)) return title
  const said = cells.filter(value => value && value !== '—')
  const parts = [...new Set([title, ...said].filter(Boolean))].slice(0, 2)
  return parts.join(' · ') || row.id
}

/** The titles more than one of these rows has. */
export function sharedTitles(rows: readonly { title: string }[]): ReadonlySet<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const { title } of rows) (seen.has(title) ? shared : seen).add(title)
  return shared
}
