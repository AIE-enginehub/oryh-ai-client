import { describe, it, expect } from 'vitest'
import { validateProject, ProjectService, type ProjectConnection, type ProjectFields, type ProjectHttp, type ProjectRecord, type ProjectStore } from '../src/index.js'

const fields: ProjectFields = { project_name: '项目测试', project_code: 'QA-1', client: '客户', start_date: '2026-09-01', end_date: '2026-09-30' }
const connection: ProjectConnection = {
  origin: 'https://oryh.example',
  identity: { permissions: ['master_data.manage'], user: { id: 'u', employeeId: 'e' }, tenant: { id: 't' } },
}
const memoryStore = (): ProjectStore => {
  const records = new Map<string, ProjectRecord>()
  return {
    list: async () => structuredClone([...records.values()]),
    append: async (record, previous) => {
      if ((records.get(record.id)?.revision ?? 0) !== previous) throw new Error('stale')
      records.set(record.id, structuredClone(record))
    },
  }
}
const service = (http: ProjectHttp) => new ProjectService(memoryStore(), http, () => connection, async () => connection)

describe('project field rules', () => {
  it('accepts a complete set and rejects each documented rule', () => {
    expect(() => validateProject(fields)).not.toThrow()
    for (const patch of [{ project_name: ' ' }, { start_date: '2026-02-30' }, { end_date: '2026-08-01' }]) {
      expect(() => validateProject({ ...fields, ...patch })).toThrow()
    }
  })
  it('allows an incomplete draft only when completeness is not required', () => {
    expect(() => validateProject({ ...fields, project_name: '' }, false)).not.toThrow()
    expect(() => validateProject({ ...fields, project_name: '' })).toThrow(/项目名称/)
  })
})

describe('creation permission', () => {
  it('refuses preparation when the server grants neither master data nor user management', async () => {
    const http: ProjectHttp = { request: async () => ({ data: { permissions: ['timesheet.submit_own'] } }) }
    await expect(service(http).projectPrepare('c', fields)).rejects.toThrow(/权限/)
  })
})

describe('malformed ORYH responses', () => {
  // Borrowed from the expense contracts before extraction, so this used to report an
  // expense conflict. Pinned here so the cross-domain error cannot quietly return.
  it('reports a project error, not an expense one', async () => {
    const http: ProjectHttp = { request: async () => 'not-an-object' }
    await expect(service(http).projectOptions('c')).rejects.toMatchObject({
      message: '项目数据无效。',
      code: 'request-failed',
    })
  })
})
