import { describe, expect, it } from 'vitest'
import {
  allowedPages,
  canAccessPage,
  hasPermission,
  PAGES,
  type PageIdentity,
  pageById,
  pageIds,
} from '../src/index.js'

const identity = (permissions: string[], employeeId: string | null = 'employee-1'): PageIdentity => ({
  permissions,
  user: { employeeId },
})

describe('page registry', () => {
  it('registers every page once, in menu order, with settings last', () => {
    expect(pageIds()).toEqual([
      'my-open-todos',
      'my-expense-claims',
      'timesheets',
      'timesheet-approvals',
      'list-projects',
      'sales-orders',
      'inventory-items',
      'inventory-item-details',
      'shipments',
      'settings',
    ])
    expect(new Set(pageIds()).size).toBe(PAGES.length)
    for (const page of PAGES) expect(pageById(page.id)).toBe(page)
  })

  it('refuses an unregistered page instead of falling through to a default', () => {
    const full = identity(['master_data.manage'])
    expect(pageById('password')).toBeUndefined()
    expect(canAccessPage(full, 'password')).toBe(false)
    expect(canAccessPage(full, '__proto__')).toBe(false)
    expect(allowedPages(full)).not.toContain('password')
  })

  it('grants a verb directly, by wildcard, and by the shipment implication only', () => {
    expect(hasPermission(identity(['inventory.manage']), 'inventory.manage')).toBe(true)
    expect(hasPermission(identity(['inventory.manage:*']), 'inventory.manage')).toBe(true)
    // Managing inventory implies shipment work, but not the reverse.
    expect(hasPermission(identity(['inventory.manage']), 'shipment.manage')).toBe(true)
    expect(hasPermission(identity(['shipment.manage']), 'inventory.manage')).toBe(false)
    expect(hasPermission(identity([]), 'inventory.manage')).toBe(false)
    expect(hasPermission({ user: { employeeId: 'e' } }, 'inventory.manage')).toBe(false)
  })

  it('gates employee pages on an employee link even when the verb is granted', () => {
    const unlinked = identity(['timesheet.submit_own', 'approval.record', 'expense.submit_own'], null)
    for (const page of ['my-open-todos', 'timesheets', 'timesheet-approvals', 'my-expense-claims']) {
      expect(canAccessPage(unlinked, page)).toBe(false)
    }
    // A page that is not employee-bound still opens for the same identity.
    expect(canAccessPage(identity(['master_data.manage'], null), 'list-projects')).toBe(true)
  })

  it('always allows settings and nothing else for an identity with no grants', () => {
    expect(allowedPages({ user: { employeeId: null } })).toEqual(['settings'])
  })

  it('returns permitted pages in menu order', () => {
    const manager = identity(['approval.record', 'inventory.manage'])
    // approval.record reaches past approvals: it also grants expenses and sales-orders,
    // and inventory.manage implies shipments. Only list-projects stays out of reach.
    expect(allowedPages(manager)).toEqual([
      'my-open-todos',
      'my-expense-claims',
      'timesheets',
      'timesheet-approvals',
      'sales-orders',
      'inventory-items',
      'inventory-item-details',
      'shipments',
      'settings',
    ])
  })
})
