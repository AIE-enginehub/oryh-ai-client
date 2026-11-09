import { describe, expect, it } from 'vitest'
import {
  allowedPages,
  canAccessPage,
  hasPermission,
  listPageForCollection,
  offersPage,
  PAGES,
  type PageIdentity,
  pageById,
  pageForCollection,
  pageIds,
} from '../src/index.js'

const identity = (permissions: string[], employeeId: string | null = 'employee-1'): PageIdentity => ({
  permissions,
  user: { employeeId },
})

describe('page registry', () => {
  it('offers the pages a person can be on, in menu order, with settings last', () => {
    expect(pageIds()).toEqual(['my-open-todos', 'analytics', 'collection', 'settings'])
    expect(new Set(PAGES.map(page => page.id)).size).toBe(PAGES.length)
    for (const page of PAGES) expect(pageById(page.id)).toBe(page)
  })

  it('keeps the record lists as what draws a list over their collection, and offers none of them as a page', () => {
    for (const page of ['sales-orders', 'inventory-items', 'inventory-item-details', 'shipments']) {
      expect(offersPage(page)).toBe(false)
      expect(pageIds()).not.toContain(page)
      // No rule of this client's stands in front of them: who may read the collection is ORYH's to say.
      expect(canAccessPage(identity([]), page)).toBe(true)
      expect(canAccessPage(identity([], null), page)).toBe(true)
    }
    expect(offersPage('my-open-todos')).toBe(true)
    expect(offersPage('password')).toBe(false)
    // The project page is gone altogether, id and rule.
    expect(pageById('list-projects')).toBeUndefined()
    // A record list draws the lists made over its collection; the generic list draws every other.
    expect(listPageForCollection('inventory-items')).toBe('inventory-items')
    expect(listPageForCollection('custom-pages')).toBe('analytics')
    expect(listPageForCollection('projects')).toBe('collection')
    expect(listPageForCollection('sales-order-items')).toBe('collection')
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
    expect(canAccessPage(unlinked, 'my-open-todos')).toBe(false)
    // The timesheet and expense pages are gone: their ids open nothing, for anyone.
    for (const page of ['timesheets', 'timesheet-approvals', 'my-expense-claims']) {
      expect(canAccessPage(identity(['timesheet.submit_own', 'approval.record', 'expense.submit_own']), page)).toBe(
        false,
      )
    }
    // A page that is not employee-bound still opens for the same identity.
    expect(canAccessPage(unlinked, 'analytics')).toBe(true)
  })

  it('always allows settings and nothing else for an identity with no grants', () => {
    // `collection` is where a person's own menu entries render, and what they may see there is
    // decided per collection, not here — so it admits everyone and shows in no menu.
    // The custom-page manager itself grants no data access; each ORYH source is reauthorized.
    expect(allowedPages({ user: { employeeId: null } })).toEqual(['analytics', 'collection', 'settings'])
  })

  it('returns permitted pages in menu order', () => {
    const manager = identity(['approval.record', 'inventory.manage'])
    // Whatever the grants, only the pages still offered: the rest are reached as lists the person made.
    expect(allowedPages(manager)).toEqual(['my-open-todos', 'analytics', 'collection', 'settings'])
  })

  it('names the page that knows a collection, where one does, and says nothing of who may read it', () => {
    expect(pageForCollection('inventory-items')).toBe('inventory-items')
    expect(pageForCollection('sales-order-items')).toBeUndefined()
    expect(pageForCollection('projects')).toBeUndefined()
    // A page that shows a NARROWING of a collection is not the page for the whole of it.
    expect(pageForCollection('expense-claims')).toBeUndefined()
    expect(pageForCollection('todos')).toBeUndefined()
  })
})
