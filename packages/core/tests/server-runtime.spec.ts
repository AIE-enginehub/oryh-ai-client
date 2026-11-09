import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerOryhHost, type DelegatedResponse, OryhClientError, type OryhRequest } from '../src/index.js'

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
    const runtime = createServerOryhHost({
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
        data: [
          {
            id: 't1',
            employee_id: 'e-a',
            entity_type: 'sales_order',
            entity_id: 'o1',
            title: '跟进',
            status: 'pending',
          },
        ],
        meta: { total: 1, page: 1, size: 100, pages: 1 },
      },
    }))
    const todos = await f.runtime.controller.execute(f.id, 'my-open-todos')
    expect(todos.result.data.map(todo => todo.id)).toContain('t1')
    // Asked through the binding as this person: no credential of this Host's was involved.
    const paths = f.sent.map(r => r.path)
    expect(paths.filter(path => path === '/auth/me').length).toBeGreaterThan(0)
    expect(paths.some(path => path.startsWith('/todos?') && path.includes('employee_id=e-a'))).toBe(true)
  })

  it('keeps ORYH status errors, and passes on a refusal the server explains', async () => {
    const f = await setup(() => ({ status: 422, body: { detail: 'unknown query parameter' } }))
    await expect(f.runtime.controller.execute(f.id, 'my-open-todos')).rejects.toThrow(
      'ORYH request failed with status 422.',
    )
    const refusing = await setup(() => {
      throw new OryhClientError('服务器版暂不支持写入。', 'request-failed')
    })
    await expect(refusing.runtime.controller.execute(refusing.id, 'my-open-todos')).rejects.toThrow(
      '服务器版暂不支持写入。',
    )
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
