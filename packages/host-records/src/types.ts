import type { RecordKind } from '@oryh/ai-client-records'

export type {
  BusinessRecord,
  CollectionQuery,
  ProductOption,
  ProductOptions,
  ProductSearch,
  RecordDetail,
  RecordDisplay,
  RecordFilterField,
  RecordFilters,
  RecordKind,
  RecordPage,
  RecordQuery,
} from '@oryh/ai-client-records'
export interface RecordFilterFieldsRequest {
  connectionId: string
  kind: RecordKind
}

/** Which record of a built-in list to read. */
export interface RecordGetRequest {
  connectionId: string
  kind: RecordKind
  id: string
}

/** Which collection to describe, for a menu entry being made or edited. */
export interface CollectionFilterFieldsRequest {
  connectionId: string
  collection: string
}

/** Which document's child tables to read. */
export interface RecordDetailRequest {
  connectionId: string
  collection: string
  id: string
}
