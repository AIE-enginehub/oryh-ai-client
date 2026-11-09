import { describe, expect, it } from 'vitest'
import { ClientPages, type PageRegistration } from './pages-registry.js'

const entry = (page: PageRegistration['page'], order: number): PageRegistration => ({
  page,
  order,
  icon: () => null,
  label: () => page,
})

describe('the page registry', () => {
  it('orders pages as the plugins asked, replaces a page registered twice, and reads unbound', () => {
    const pages = new ClientPages()
    const { subscribe, getSnapshot } = pages
    let changes = 0
    const off = subscribe(() => {
      changes++
    })
    const removeTodos = pages.register(entry('my-open-todos', 10))
    pages.register(entry('inventory-item-details', 40))
    pages.register(entry('shipments', 30))
    expect(getSnapshot().pages.map(p => p.page)).toEqual(['my-open-todos', 'shipments', 'inventory-item-details'])
    // A page plugin reloading registers again: one entry per page, the newer one.
    const later = entry('shipments', 5)
    pages.register(later)
    expect(getSnapshot().pages.map(p => p.page)).toEqual(['shipments', 'my-open-todos', 'inventory-item-details'])
    expect(pages.get('shipments')).toBe(later)
    removeTodos()
    expect(pages.get('my-open-todos')).toBeUndefined()
    // A stale disposer, after its entry was replaced, removes nothing.
    removeTodos()
    expect(changes).toBe(5)
    off()
    pages.register(entry('shipments', 50))
    expect(changes).toBe(5)
  })
})
