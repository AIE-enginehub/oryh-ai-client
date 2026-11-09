import { describe, expect, it, vi } from 'vitest'
import { type RecordConnection, RecordService } from '../src/index.js'

const identity = (permissions: string[] = [], employeeId: string | null = 'e') => ({
  permissions,
  user: { id: 'u', role: 'admin', employeeId },
  tenant: { id: 't' },
})

describe('who may read a list', () => {
  it('asks ORYH as the person on every read, so a permission revoked there is refused there', async () => {
    let current = { origin: 'https://example.test', identity: identity(['inventory.manage']) } as RecordConnection
    const request = vi.fn(async () => ({ data: [], meta: { total: 0, pages: 1 } }))
    const service = new RecordService(
      { request } as never,
      async () => current,
      () => current,
    )
    await service.recordList({ connectionId: 'c', kind: 'inventory-items', query: '', page: 1 })
    // The grant is gone in ORYH. This client keeps no rule of its own over the list, so it does not refuse
    // by itself: the read goes to ORYH as this person, and ORYH's refusal is what they are told.
    current = { ...current, identity: identity() }
    request.mockClear()
    const refusal = new Error('ORYH 没有允许当前账号读取或办理这项内容（HTTP 403）。权限由 ORYH 的管理员设置。')
    request.mockRejectedValue(refusal)
    await expect(service.recordList({ connectionId: 'c', kind: 'inventory-items', query: '', page: 1 })).rejects.toBe(
      refusal,
    )
    await expect(service.productSearch({ connectionId: 'c', query: 'P', page: 1 })).rejects.toBe(refusal)
    expect(request).toHaveBeenCalled()
  })
})
