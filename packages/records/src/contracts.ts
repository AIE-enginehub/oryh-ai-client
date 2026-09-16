export type RecordKind='sales-orders'|'inventory-items'|'inventory-item-details'|'shipments'
/**
 * A query parameter a list endpoint declares, as its deployment describes it. Filters are checked
 * against these, because the server silently ignores anything it does not declare.
 */
export interface RecordFilterField {name:string;type:'string'|'integer'|'number'|'boolean'}
/** Equality filters sent to the server as query parameters; keys must be declared by the endpoint. */
export type RecordFilters=Record<string,string>
export interface RecordQuery {connectionId:string;kind:RecordKind;page:number;query:string;productCode?:string;productIds?:string[];filters?:RecordFilters}
export interface BusinessRecord {id:string;title:string;status:string;summary:string;date:string;fields:{label:string;value:string}[]}
export interface RecordPage {rows:BusinessRecord[];page:number;pages:number;total:number;fetchedAt:string}
export interface ProductOption {id:string;code:string;name:string}
export interface ProductSearch {connectionId:string;query:string;page:number;ids?:string[]}
export interface ProductOptions {rows:ProductOption[];total:number;pages:number}
export interface OryhRecordRemote {productSearch(query:ProductSearch):Promise<ProductOptions>;recordList(query:RecordQuery):Promise<RecordPage>;recordFilterFields(connectionId:string,kind:RecordKind):Promise<RecordFilterField[]>}
