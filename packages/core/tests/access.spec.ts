import { describe, expect, it } from 'vitest'
import { canAccessPage, hasPermission } from '../src/access.js'
import { decodeIdentity, type OryhIdentity } from '../src/contracts.js'

const identity = (permissions: string[] = [], employeeId: string | null = 'e') =>
  ({ permissions, user: { id: 'u', role: 'admin', employeeId }, tenant: { id: 't' } }) as OryhIdentity
describe('server-granted business access', () => {
  it('opens the to-do page for an employee and no page that does not exist, whatever the role or grants', () => {
    expect(canAccessPage(identity(), 'my-open-todos')).toBe(true)
    expect(canAccessPage(identity([], null), 'my-open-todos')).toBe(false)
    // The timesheet and expense pages are gone, and a grant that used to open them opens nothing by that name.
    expect(canAccessPage(identity(['timesheet.submit_own']), 'timesheets')).toBe(false)
    expect(canAccessPage(identity(['approval.record']), 'timesheet-approvals')).toBe(false)
    expect(canAccessPage(identity(), 'list-projects')).toBe(false)
    expect(canAccessPage(identity(), 'invented-page')).toBe(false)
    // The record lists carry no rule of this client's: who may read them is ORYH's to say.
    expect(canAccessPage(identity(), 'inventory-items')).toBe(true)
    expect(canAccessPage(identity([], null), 'sales-orders')).toBe(true)
  })
  it('supports server wildcard syntax and inventory-implied shipping without granting the reverse', () => {
    expect(hasPermission(identity(['master_data.manage:*']), 'master_data.manage')).toBe(true)
    expect(hasPermission(identity(['inventory.manage']), 'shipment.manage')).toBe(true)
    expect(hasPermission(identity(['shipment.manage']), 'inventory.manage')).toBe(false)
  })
  it('retains only permission strings returned by auth/me', () => {
    const value = decodeIdentity({
      data: {
        id: 'u',
        email: 'u@example.test',
        role: 'admin',
        employee_id: 'e',
        tenant_id: 't',
        tenant: { slug: 't' },
        permissions: ['inventory.manage', 5],
      },
    })
    expect(value.permissions).toEqual(['inventory.manage'])
  })
})
