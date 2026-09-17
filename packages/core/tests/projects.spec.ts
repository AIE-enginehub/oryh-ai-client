import {
  type ProjectFields,
  type ProjectRecord,
  ProjectService,
  type ProjectStore,
  validateProject,
} from '@oryh/ai-client-projects'
import { describe, expect, it } from 'vitest'
import { ConnectionRegistry, MemoryCredentialVault, OryhHttpClient } from '../src/index.js'
import { jsonResponse } from './fixtures.js'

const fields: ProjectFields = {
  project_name: '项目测试',
  project_code: 'QA-1',
  client: '客户',
  start_date: '2026-09-01',
  end_date: '2026-09-30',
}
async function fixture() {
  const registry = new ConnectionRegistry(),
    vault = new MemoryCredentialVault(),
    c = registry.add({
      origin: 'https://oryh.example',
      identity: {
        user: { id: 'u', email: 'u@example.invalid', role: 'member', employeeId: 'e' },
        tenant: { id: 't', slug: 'test', name: 'Test', environmentId: null },
      },
    })
  registry.markVerified(c.id, c.identity)
  await vault.write(c.id, { accessKey: 'synthetic', refreshToken: 'synthetic', expiresAt: null })
  const records = new Map<string, ProjectRecord>(),
    projects: Record<string, any>[] = [],
    calls: { method: string; body: any }[] = []
  let permissions = ['master_data.manage'],
    lose = false,
    reject = 0
  const store: ProjectStore = {
    list: async () => structuredClone([...records.values()]),
    append: async (r, previous) => {
      if ((records.get(r.id)?.revision ?? 0) !== previous) throw Error('stale')
      records.set(r.id, structuredClone(r))
    },
  }
  const http = new OryhHttpClient(registry, vault, async (url, init) => {
    const method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, body })
    if (url.endsWith('/auth/me')) return jsonResponse(200, { data: { permissions } })
    if (method === 'GET') return jsonResponse(200, { data: projects, meta: { pages: 1 } })
    if (reject) return jsonResponse(reject, { detail: 'secret error' })
    const p = { id: 'new-project', ...body }
    projects.push(p)
    if (lose) throw Error('lost')
    return jsonResponse(201, { data: p })
  })
  const service = () =>
    new ProjectService(
      store,
      http,
      id => registry.requireVerified(id as typeof c.id),
      async () => registry.requireVerified(c.id),
    )
  return {
    s: service(),
    service,
    c,
    records,
    projects,
    calls,
    permissions: (p: string[]) => {
      permissions = p
    },
    lose: () => {
      lose = true
    },
    reject: (v: number) => {
      reject = v
    },
  }
}
describe('project creation', () => {
  it('rejects invalid names/dates without silently changing dates', () => {
    expect(() => validateProject(fields)).not.toThrow()
    for (const patch of [{ project_name: ' ' }, { start_date: '2026-02-30' }, { end_date: '2026-08-01' }])
      expect(() => validateProject({ ...fields, ...patch })).toThrow()
  })
  it('checks actual permission and leaves the server untouched until confirmation', async () => {
    const f = await fixture()
    f.permissions([])
    await expect(f.s.projectPrepare(f.c.id, fields)).rejects.toThrow(/权限/)
    f.permissions(['users.manage'])
    const review = await f.s.projectPrepare(f.c.id, fields)
    expect(f.projects).toHaveLength(0)
    expect(review.state).toBe('review')
    expect((await f.s.projectConfirm(f.c.id, review.id, review.revision, review.token)).state).toBe('created')
    expect(f.projects).toHaveLength(1)
    expect(f.projects[0]!.metadata.oryh_client_intent_id).toBe(review.id)
    await expect(f.s.projectConfirm(f.c.id, review.id, review.revision, review.token)).rejects.toThrow()
  })
  it('uses one durable confirmation under concurrent clicks', async () => {
    const f = await fixture(),
      r = await f.s.projectPrepare(f.c.id, fields)
    await Promise.allSettled([
      f.s.projectConfirm(f.c.id, r.id, r.revision, r.token),
      f.s.projectConfirm(f.c.id, r.id, r.revision, r.token),
    ])
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it('reconciles a lost creation receipt after a service restart without resending', async () => {
    const f = await fixture(),
      r = await f.s.projectPrepare(f.c.id, fields)
    f.lose()
    const n = await f.s.projectConfirm(f.c.id, r.id, r.revision, r.token)
    expect(n.state).toBe('unknown')
    await expect(f.s.projectPrepare(f.c.id, { ...fields, project_code: 'QA-2' })).rejects.toThrow(/尚未确认/)
    expect((await f.service().projectReconcile(f.c.id, n.id, n.revision)).state).toBe('created')
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it('rejects expired confirmations, revoked rights and duplicate codes', async () => {
    const f = await fixture(),
      r = await f.s.projectPrepare(f.c.id, fields)
    f.records.get(r.id)!.expiresAt = 0
    await expect(f.s.projectConfirm(f.c.id, r.id, r.revision, r.token)).rejects.toThrow(/过期/)
    f.projects.push({ ...fields, id: 'existing' })
    await expect(f.s.projectPrepare(f.c.id, fields)).rejects.toThrow(/编码已存在/)
    f.permissions([])
    await expect(f.s.projectConfirm(f.c.id, r.id, r.revision, r.token)).rejects.toThrow(/权限/)
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })
  it('reports a definitive server rejection without echoing response data', async () => {
    const f = await fixture(),
      r = await f.s.projectPrepare(f.c.id, fields)
    f.reject(409)
    const n = await f.s.projectConfirm(f.c.id, r.id, r.revision, r.token)
    expect(n.state).toBe('failed')
    expect(n.message).not.toContain('secret')
  })
})
