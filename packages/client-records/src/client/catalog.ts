import { type RecordKind, recordColumns, recordDefaultColumns, recordSpecs } from '@oryh/ai-client-records'
import type { ColumnCatalog, OryhKey } from '@oryh/dsh-client-frame/client'

export const isRecordKind = (value: string): value is RecordKind => Object.hasOwn(recordSpecs, value)
/** What each list is called, as a key in the frame's dictionary. */
export const recordPageLabels: Record<RecordKind, OryhKey> = {
  'sales-orders': 'salesOrders',
  'inventory-items': 'inventoryItems',
  'inventory-item-details': 'inventoryDetails',
  shipments: 'shipments',
}
/** One list's columns, for the preference store. */
export function recordCatalog(kind: RecordKind): ColumnCatalog {
  return { allowed: recordColumns(kind), defaults: recordDefaultColumns[kind] }
}
