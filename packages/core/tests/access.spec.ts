import { RecordService } from '@oryh/ai-client-records'
import { describe, expect, it, vi } from 'vitest'
import { canAccessPage, hasPermission } from '../src/access.js'
import type { ConnectionSummary } from '../src/connections.js'
import { decodeIdentity, type OryhIdentity } from '../src/contracts.js'

const identity = (permissions: string[] = [], employeeId: string | null = 'e') =>
  ({ permissions, user: { id: 'u', role: 'admin', employeeId }, tenant: { id: 't' } }) as OryhIdentity
describe('server-granted business access', () => {
  it('does not grant privileges from a role name, persisted view or missing permissions', () => {
    expect(canAccessPage(identity(), 'list-projects')).toBe(false)
    expect(canAccessPage(identity(), 'inventory-items')).toBe(false)
    expect(canAccessPage(identity(['timesheet.submit_own']), 'timesheets')).toBe(true)
    expect(canAccessPage(identity(['timesheet.submit_own']), 'timesheet-approvals')).toBe(false)
    expect(canAccessPage(identity(['approval.record']), 'timesheet-approvals')).toBe(true)
    expect(canAccessPage(identity(['approval.record'], null), 'timesheet-approvals')).toBe(false)
    expect(canAccessPage(identity(), 'invented-page')).toBe(false)
  })
  it('supports server wildcard syntax and inventory-implied shipping without granting the reverse', () => {
    expect(hasPermission(identity(['master_data.manage:*']), 'master_data.manage')).toBe(true)
    expect(canAccessPage(identity(['inventory.manage']), 'shipments')).toBe(true)
    expect(canAccessPage(identity(['shipment.manage']), 'inventory-items')).toBe(false)
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
  it('blocks direct Remote reads and product lookup after permissions are revoked', async () => {
    let current = { origin: 'https://example.test', identity: identity(['inventory.manage']) } as ConnectionSummary
    const request = vi.fn(async () => ({ data: [], meta: { total: 0, pages: 1 } }))
    const service = new RecordService(
      { request } as never,
      async () => current,
      () => current,
    )
    await service.recordList({ connectionId: 'c', kind: 'inventory-items', query: '', page: 1 })
    current = { ...current, identity: identity() }
    request.mockClear()
    await expect(
      service.recordList({ connectionId: 'c', kind: 'inventory-items', query: '', page: 1 }),
    ).rejects.toThrow('权限')
    await expect(service.productSearch({ connectionId: 'c', query: 'P', page: 1 })).rejects.toThrow('权限')
    expect(request).not.toHaveBeenCalled()
  })
})
