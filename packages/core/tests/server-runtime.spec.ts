import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerOryhRuntime, type DelegatedResponse, OryhClientError, type OryhRequest } from '../src/index.js'

const identity = {
  user: { id: 'u-a', email: 'a@example.test', name: null, role: 'member', employeeId: 'e-a' },
  tenant: { id: 't-a', slug: 'a', name: 'A', environmentId: null },
  permissions: ['timesheet.submit_own'],
}
const me = {
  data: {
    id: 'u-a',
    email: 'a@example.test',
    role: 'member',
    employee_id: 'e-a',
    tenant_id: 't-a',
    tenant: { slug: 'a', name: 'A' },
    permissions: ['timesheet.submit_own'],
  },
}

describe('the server business runtime', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  async function setup(answer: (request: OryhRequest) => DelegatedResponse | Promise<DelegatedResponse>) {
    const root = await mkdtemp(join(tmpdir(), 'oryh-server-runtime-'))
    roots.push(root)
    const sent: OryhRequest[] = []
    const runtime = createServerOryhRuntime({
      binding: {
        origin: 'https://oryh.example.test',
        identity,
        signal: new AbortController().signal,
        send: async request => {
          sent.push(request)
          return request.path === '/auth/me' ? { status: 200, body: me } : answer(request)
        },
      },
      dataDirectory: join(root, 'data'),
      agentsHome: join(root, 'agents'),
      storeSecret: Buffer.alloc(32, 7),
    })
    const [connection] = await runtime.controller.listConnections()
    return { runtime, sent, root, id: connection!.id }
  }

  it('reads business data through the binding, with no local credential', async () => {
    const f = await setup(() => ({
      status: 200,
      body: {
        data: [{ id: 'h1', employee_id: 'e-a', period_start: '2026-09-07', period_end: '2026-09-13', status: 'draft' }],
        meta: { pages: 1 },
      },
    }))
    const list = await f.runtime.timesheets.timesheetList(f.id)
    expect(list.map(h => h.id)).toEqual(['h1'])
    expect(f.sent.map(r => r.path)).toEqual([
      '/auth/me',
      '/auth/me',
      '/timesheet-headers?employee_id=e-a&page=1&size=100',
    ])
  })

  it('keeps ORYH status errors, and passes on a refusal the server explains', async () => {
    const f = await setup(() => ({ status: 422, body: { detail: 'unknown query parameter' } }))
    await expect(f.runtime.timesheets.timesheetList(f.id)).rejects.toThrow('ORYH request failed with status 422.')
    const refusing = await setup(() => {
      throw new OryhClientError('服务器版暂不支持写入。', 'request-failed')
    })
    await expect(refusing.runtime.timesheets.timesheetList(refusing.id)).rejects.toThrow('服务器版暂不支持写入。')
  })

  it('installs skills read over MCP into its own skills directory', async () => {
    const f = await setup(request => {
      if (request.path === '/my/skills/manifest')
        return { status: 200, body: { data: [{ name: 'oryh-a', version: '1' }] } }
      const message = request.body as { id: number; method: string }
      const result =
        message.method === 'prompts/list'
          ? { prompts: [{ name: 'oryh-a', description: 'A' }] }
          : message.method === 'prompts/get'
            ? { messages: [{ role: 'user', content: { type: 'text', text: '---\nname: oryh-a\n---\nbody' } }] }
            : { resources: [] }
      return { status: 200, body: { jsonrpc: '2.0', id: message.id, result } }
    })
    await f.runtime.skills.sync(f.id)
    expect(await readdir(join(f.root, 'agents', 'skills'))).toContain('oryh-a')
    expect(await readFile(join(f.root, 'agents', 'skills', 'oryh-a', 'SKILL.md'), 'utf8')).toContain('body')
  })
})
