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
  | 'my-expense-claims'
  | 'timesheets'
  | 'timesheet-approvals'
  | 'list-projects'
  | 'sales-orders'
  | 'inventory-items'
  | 'inventory-item-details'
  | 'shipments'
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

const any = (identity: PageIdentity, ...verbs: string[]): boolean => verbs.some(verb => hasPermission(identity, verb))
const employee = (identity: PageIdentity): boolean => Boolean(identity.user.employeeId)

/**
 * Product entry policy in menu order, using server grants rather than role names.
 *
 * Read APIs may be broader; these rules are the client's functional entry limits and
 * do not replace ORYH's row-level authorization.
 */
export const PAGES: readonly PageDefinition[] = [
  { id: 'my-open-todos', title: '我的待办', access: employee },
  {
    id: 'my-expense-claims',
    title: '费用申请',
    access: i => employee(i) && any(i, 'expense.submit_own', 'expense.advance', 'approval.record'),
  },
  {
    id: 'timesheets',
    title: '我的工时',
    access: i => employee(i) && any(i, 'timesheet.submit_own', 'timesheet.advance', 'approval.record'),
  },
  { id: 'timesheet-approvals', title: '工时审批', access: i => employee(i) && any(i, 'approval.record') },
  { id: 'list-projects', title: '项目', access: i => any(i, 'master_data.manage', 'users.manage') },
  {
    id: 'sales-orders',
    title: '销售订单',
    access: i => any(i, 'order.submit_own', 'order.advance', 'approval.record'),
  },
  { id: 'inventory-items', title: '库存余额', access: i => any(i, 'inventory.manage') },
  { id: 'inventory-item-details', title: '库存流水', access: i => any(i, 'inventory.manage') },
  { id: 'shipments', title: 'Shipment · 收发货', access: i => any(i, 'shipment.manage') },
  { id: 'settings', title: '企业连接', access: () => true },
]

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
 * Every registered page id, in menu order.
 * @returns the ids, for menus and model tool enums.
 */
export function pageIds(): PageId[] {
  return PAGES.map(page => page.id)
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
  return PAGES.filter(page => page.access(identity)).map(page => page.id)
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
