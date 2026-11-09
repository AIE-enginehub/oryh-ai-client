export type RecordKind = 'sales-orders' | 'inventory-items' | 'inventory-item-details' | 'shipments'
/**
 * A query parameter a list endpoint declares, as its deployment describes it. Filters are checked
 * against these, because the server silently ignores anything it does not declare.
 */
export interface RecordFilterField {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean'
}
/** One entry of the menu a person's permissions imply: a collection, how it is narrowed, how it shows. */
export interface RoleView {
  collection: string
  filters: RecordFilters
  label: string
  display: RecordDisplay
  /** The permissions that imply it; the page drops it the moment none of them is held. */
  grants: string[]
}
/** One field the rows of a list carry, as the deployment's own schema declares it. */
export interface RecordRowField {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean'
  /** The endpoint always sends it, so a column over it is never blank for want of the field. */
  required: boolean
}
/** Equality filters sent to the server as query parameters; keys must be declared by the endpoint. */
export type RecordFilters = Record<string, string>
export interface RecordQuery {
  connectionId: string
  kind: RecordKind
  page: number
  query: string
  productCode?: string
  productIds?: string[]
  filters?: RecordFilters
}
/**
 * How one list is shown: which field titles a row, and the columns under the names a person reads.
 *
 * The four built-in lists carry a hand-written one (`recordSpecs`). A menu entry a person made through
 * Chat carries its own, whose structure came from the deployment's schema and whose names came from
 * the agent that made it.
 */
export interface RecordDisplay {
  /** Field whose value titles a row; the id when absent or empty. */
  title?: string
  summary?: string
  date?: string
  /** The columns, in the order they are shown. */
  columns: { field: string; label: string }[]
}

/** One page of any ORYH collection, as a menu entry defines it. */
export interface CollectionQuery {
  connectionId: string
  /** Collection as ORYH's own catalogue names it, which is also its list path. */
  collection: string
  page: number
  filters?: RecordFilters
  display: RecordDisplay
}

/** One record of a collection a menu entry names, shown as that entry shows its rows. */
export interface CollectionRecordQuery {
  connectionId: string
  collection: string
  id: string
  display: RecordDisplay
}

/** One child table of a document's detail: its lines, approvals, attachments and the like. */
export interface RecordChild {
  /** The key ORYH names it by in the detail, e.g. `items`. */
  key: string
  /** What a person reads above it. */
  label: string
  columns: { field: string; label: string }[]
  rows: Record<string, string>[]
}

/** What `GET /{collection}/{id}/detail` adds to a record: the tables that hang off it. */
export interface RecordDetail {
  children: RecordChild[]
}

export interface BusinessRecord {
  id: string
  title: string
  status: string
  summary: string
  date: string
  /**
   * The fields as shown. `field` is the API's name for a built-in field, so a display can be translated
   * by that stable key; a tenant's own field may have none.
   */
  fields: { field?: string; label: string; value: string }[]
}
export interface RecordPage {
  rows: BusinessRecord[]
  page: number
  pages: number
  total: number
  fetchedAt: string
}
export interface ProductOption {
  id: string
  code: string
  name: string
}
export interface ProductSearch {
  connectionId: string
  query: string
  page: number
  ids?: string[]
}
export interface ProductOptions {
  rows: ProductOption[]
  total: number
  pages: number
}
export interface OryhRecordRemote {
  productSearch(query: ProductSearch): Promise<ProductOptions>
  recordList(query: RecordQuery): Promise<RecordPage>
  /** One record of a built-in list by id, as that list shows a row: what opens when a record is named. */
  recordGet(connectionId: string, kind: RecordKind, id: string): Promise<BusinessRecord>
  recordFilterFields(connectionId: string, kind: RecordKind): Promise<RecordFilterField[]>
  /** One page of a collection a menu entry names, shown as that entry says. */
  collectionList(query: CollectionQuery): Promise<RecordPage>
  /** One record of such a collection by id, wherever the entry's filters and pages would put it. */
  collectionGet(query: CollectionRecordQuery): Promise<BusinessRecord>
  /** What a collection can be filtered by on this deployment. */
  collectionFilterFields(connectionId: string, collection: string): Promise<RecordFilterField[]>
  /** A document's child tables, from ORYH's own detail; none when the collection has no detail. */
  recordDetail(connectionId: string, collection: string, id: string): Promise<RecordDetail>
  /** What the rows of a collection carry, as the deployment's schema declares them. */
  collectionRowFields(connectionId: string, collection: string): Promise<RecordRowField[]>
  /** The menu this identity's permissions imply, each entry ready to show. Host-side only. */
  roleViews(connectionId: string): Promise<RoleView[]>
}
