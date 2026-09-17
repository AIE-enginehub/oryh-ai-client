import type { RecordKind } from '@oryh/ai-client-records'

export type {
  BusinessRecord,
  ProductOption,
  ProductOptions,
  ProductSearch,
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
