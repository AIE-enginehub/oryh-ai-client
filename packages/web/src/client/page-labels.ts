import type {PageId} from '@oryh/ai-client-pages'
import type {OryhKey} from './locale.js'

/**
 * What each built-in page is called, said once.
 *
 * The menu, the breadcrumb and the page's own heading all read this, so a page can no longer be
 * 「项目」 in the menu and 「项目列表」 on the page. The Host names pages to the agent from the page
 * registry, and `page-labels.spec.ts` keeps that wording equal to this one. A person's own menu
 * entries are data and carry their own label.
 */
export const pageLabels: Record<PageId, OryhKey> = {
  'my-open-todos': 'text8',
  'my-expense-claims': 'text10',
  timesheets: 'tsMine',
  'timesheet-approvals': 'tsApprovals',
  'list-projects': 'text12',
  'sales-orders': 'salesOrders',
  'inventory-items': 'inventoryItems',
  'inventory-item-details': 'inventoryDetails',
  shipments: 'shipments',
  settings: 'text15',
}
