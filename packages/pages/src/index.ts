/** The one registry of ORYH business pages, shared by the core, the Host plugin and the client. */

import { OryhClientError } from '@oryh/ai-client-foundation'

/**
 * The identity fields page rules read.
 *
 * Declared structurally instead of imported: the core depends on this package, so
 * importing the core's identity type back would close a cycle. `OryhIdentity`
 * satisfies this shape.
 */
export interface PageIdentity {
  readonly permissions?: readonly string[]
  readonly user: { readonly employeeId: string | null }
}

/** Every business page the client can open. */
export type PageId =
  | 'my-open-todos'
  | 'sales-orders'
  | 'inventory-items'
  | 'inventory-item-details'
  | 'shipments'
  | 'analytics'
  | 'collection'
  | 'settings'

/**
 * One page's identity, model-facing name and entry rule.
 *
 * Presentation stays in the client: icons and components would drag React into the
 * core's dependency graph, and the menu's locale key is never read by the Host. Views
 * map both by id, so the compiler checks that mapping for completeness.
 */
export interface PageDefinition {
  /** Stable page id used by menus, navigation commands and tool enums. */
  readonly id: PageId
  /** Name the Host reports to the model for the live page. */
  readonly title: string
  /** Whether this identity may open the page at all. */
  readonly access: (identity: PageIdentity) => boolean
  /**
   * No longer a page of its own (docs/57): it is in no menu, nobody is taken to it, and the agent cannot
   * navigate there. It is still what draws a list a person made over its collection.
   */
  readonly retired?: true
}

/**
 * Whether the server granted this verb.
 * @param identity - authenticated identity.
 * @param verb - permission verb.
 * @returns true when granted directly, by wildcard, or by implication.
 */
export function hasPermission(identity: PageIdentity, verb: string): boolean {
  const granted = identity.permissions ?? []
  return (
    granted.includes(verb) ||
    granted.includes(`${verb}:*`) ||
    // Shipment handling is part of managing inventory.
    (verb === 'shipment.manage' && hasPermission(identity, 'inventory.manage'))
  )
}

const employee = (identity: PageIdentity): boolean => Boolean(identity.user.employeeId)

/**
 * The pages, in menu order, and who may open each.
 *
 * Only the to-do page has a rule of its own: it is the signed-in employee's list, and someone with no
 * employee record has none. Who may read a collection is ORYH's to decide. This client used to add entry
 * rules of its own over projects, sales orders, inventory and shipments — narrower than ORYH's read
 * permissions — but they held only for menus and pages, while the agent read the same collections under
 * ORYH's permissions alone; they were removed on 2026-10-11, and a person ORYH does not let read a
 * collection is told so by ORYH when the list is read.
 */
export const PAGES: readonly PageDefinition[] = [
  { id: 'my-open-todos', title: '我的待办', access: employee },
  // The four record lists: no longer pages, kept as what draws a list made over these collections.
  { id: 'sales-orders', title: '销售订单', access: () => true, retired: true },
  { id: 'inventory-items', title: '库存余额', access: () => true, retired: true },
  { id: 'inventory-item-details', title: '库存流水', access: () => true, retired: true },
  { id: 'shipments', title: 'Shipment · 收发货', access: () => true, retired: true },
  {
    id: 'analytics',
    title: '自定义页面',
    // The page itself grants no source access; every source is checked against ORYH on read/load/run.
    access: () => true,
  },
  // Where a menu entry over a collection this client ships no page for is shown. It is a page, not a
  // menu item: nothing registers a menu entry for it, and what a person may see there is ORYH's to decide.
  { id: 'collection', title: '自定义列表', access: () => true },
  { id: 'settings', title: '企业连接', access: () => true },
]

/**
 * The page that draws a list over a whole ORYH collection, where this client has one that knows the
 * collection: its columns, its filters, its record view. Every other collection is drawn by the generic
 * list. This says nothing about who may read a collection.
 */
const COLLECTION_PAGES: Readonly<Record<string, PageId>> = {
  'custom-pages': 'analytics',
  'sales-orders': 'sales-orders',
  'inventory-items': 'inventory-items',
  'inventory-item-details': 'inventory-item-details',
  shipments: 'shipments',
}

/**
 * The page that knows a collection.
 * @param collection - collection as ORYH's catalogue names it.
 * @returns the page, or undefined when this client ships no page over that whole collection.
 */
export function pageForCollection(collection: string): PageId | undefined {
  return Object.hasOwn(COLLECTION_PAGES, collection) ? COLLECTION_PAGES[collection] : undefined
}

/**
 * The page that draws a list a person made over a collection.
 * @param collection - collection as ORYH's catalogue names it.
 * @returns the record list or custom page that knows the collection, or the generic list.
 */
export function listPageForCollection(collection: string): PageId {
  return pageForCollection(collection) ?? 'collection'
}

const byId = new Map<string, PageDefinition>(PAGES.map(page => [page.id, page]))

/**
 * Look one page up.
 * @param id - candidate page id, which may come from stored state or a model argument.
 * @returns the page, or undefined when the id is not registered.
 */
export function pageById(id: string): PageDefinition | undefined {
  return byId.get(id)
}

/**
 * Every page a person can be on in its own right, in menu order.
 * @returns the ids, for menus and model tool enums.
 */
export function pageIds(): PageId[] {
  return PAGES.filter(page => !page.retired).map(page => page.id)
}

/**
 * Whether the id is a page a person can be on in its own right.
 * @param id - candidate page id.
 * @returns false for an unregistered id and for a retired page.
 */
export function offersPage(id: string): boolean {
  const page = byId.get(id)
  return page !== undefined && !page.retired
}

/**
 * Whether this identity may open the page.
 * @param identity - authenticated identity.
 * @param page - candidate page id.
 * @returns false for an unregistered id, so an unknown page is never reachable.
 */
export function canAccessPage(identity: PageIdentity, page: string): boolean {
  return byId.get(page)?.access(identity) ?? false
}

/**
 * The pages this identity may open.
 * @param identity - authenticated identity.
 * @returns permitted ids in menu order.
 */
export function allowedPages(identity: PageIdentity): PageId[] {
  return PAGES.filter(page => !page.retired && page.access(identity)).map(page => page.id)
}

/**
 * Refuse a page this identity may not open.
 * @param identity - authenticated identity.
 * @param page - candidate page id.
 * @throws when the page is unregistered or not permitted.
 */
export function requirePage(identity: PageIdentity, page: string): void {
  if (!canAccessPage(identity, page)) throw new OryhClientError('当前账号没有此业务功能的访问权限。', 'request-failed')
}

/**
 * Refuse an operation this identity may not perform.
 * @param identity - authenticated identity.
 * @param verb - permission verb.
 * @throws when the verb is not granted.
 */
export function requirePermission(identity: PageIdentity, verb: string): void {
  if (!hasPermission(identity, verb)) throw new OryhClientError('当前账号没有执行此操作的权限。', 'request-failed')
}
