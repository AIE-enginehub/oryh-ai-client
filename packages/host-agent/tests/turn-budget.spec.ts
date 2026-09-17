/**
 * The cost of one agent turn, as a regression baseline (docs/37 阶段 5, docs/evidence).
 *
 * The real connection layer, the real pane, the real timesheet service and its tools, over a link
 * that counts what reaches ORYH. A turn is: the agent starts running, calls three tools, goes idle.
 * What is asserted here is what stage 2 and stage 5 bought — one identity check per turn however
 * many tools run, and reference data read once rather than per call.
 */
import { createServerOryhHost, type DelegatedResponse, type OryhRequest } from '@oryh/ai-client-core'
import { MemoryTimesheetStore } from '@oryh/ai-client-timesheets'
import { installPaneTools, PaneService, SubmitReview, UserViewRegistry } from '@oryh/dsh-pane'
import { fakeContext, paneSyncer, tempDirectory } from '@oryh/dsh-pane/testing'
import { TimesheetChat } from '@oryh/dsh-timesheets'
import { expect, it } from 'vitest'
import { BusinessAgent } from '../src/business-agent.js'

const identity = {
  user: { id: 'u', email: 'u@example.test', name: 'U', role: 'member', employeeId: 'e' },
  tenant: { id: 't', slug: 't', name: 'T', environmentId: null },
  permissions: ['timesheet.submit_own', 'approval.record'],
}
const me = {
  data: {
    id: 'u',
    email: 'u@example.test',
    name: 'U',
    role: 'member',
    employee_id: 'e',
    tenant_id: 't',
    tenant: { slug: 't', name: 'T' },
    permissions: identity.permissions,
  },
}

it('costs one identity check per turn, and reads reference data once across turns', async () => {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const requests: string[] = []
  const lifetime = new AbortController()
  const kit = createServerOryhHost({
    binding: {
      origin: 'https://oryh.example.test',
      identity,
      signal: lifetime.signal,
      send: async (request: OryhRequest): Promise<DelegatedResponse> => {
        requests.push(request.path.split('?')[0]!)
        if (request.path === '/auth/me') return { status: 200, body: me }
        if (request.root) return { status: 200, body: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }
        return { status: 200, body: { data: [], meta: { pages: 1 } } }
      },
    },
    dataDirectory: temp.directory,
    agentsHome: `${temp.directory}/agents`,
    storeSecret: Buffer.alloc(32, 1),
  })
  const pane = new PaneService(harness.ctx, kit.controller, temp.directory, new UserViewRegistry(harness.ctx))
  installPaneTools(harness.ctx, pane)
  const timesheets = kit.host.createTimesheetRemote(new MemoryTimesheetStore())
  pane.onServerChange(() => timesheets.invalidate())
  new TimesheetChat(harness.ctx, timesheets, pane, new SubmitReview(harness.ctx, pane)).install()
  new BusinessAgent(harness.ctx, {
    controller: kit.controller,
    host: kit.host,
    pane,
    capabilities: { shell: false, writes: true },
  }).install()
  try {
    const [connection] = await kit.controller.listConnections()
    await pane.bind({ sessionId: 's', connectionId: connection!.id })
    const page = paneSyncer(pane, 's')
    // paneSyncer speaks for connection `c`; this Host's one connection has its own id.
    const sync = () =>
      pane.sync({
        sessionId: 's',
        connectionId: connection!.id,
        instance: 'i',
        revision: page.revision + 100 + requests.length,
        page: 'timesheets',
        context: {
          key: 'timesheets:new',
          title: '',
          detail: '',
          scope: '',
          timesheet: {
            manager: false,
            fields: { period_start: '2026-09-14', period_end: '2026-09-14', source_report_text: '', entries: [] },
          },
        },
      })
    sync()
    const exec = { agent: { id: 's' }, callId: 'call', signal: new AbortController().signal }
    const status = (value: string) =>
      harness.emit('agent/status', { agent: { id: 's', inbox: { nextTurn: [] } }, status: value })
    const turn = async () => {
      const before = requests.length
      status('running')
      await harness.tool('oryh_current_page').execute({}, exec)
      await harness.tool('oryh_find_timesheets').execute({}, exec)
      await harness.tool('oryh_timesheet_read').execute({}, exec)
      status('idle')
      return requests.slice(before)
    }
    const first = await turn()
    const second = await turn()
    const count = (list: string[], path: string) => list.filter(p => p === path).length
    console.log(`turn 1: ${first.length} ORYH requests — ${summary(first)}`)
    console.log(`turn 2: ${second.length} ORYH requests — ${summary(second)}`)
    // One identity check per turn, whatever the number of tools.
    expect(count(first, '/auth/me')).toBe(1)
    expect(count(second, '/auth/me')).toBe(1)
    // Reference data — projects, work types, the state machine, the workflow's requirements — is
    // read in the first turn only; the second turn reads what can change: headers and todos.
    for (const path of ['/projects', '/type-options', '/object-type-definitions', '/workflow-definitions'])
      expect(count(second, path), path).toBe(0)
    expect(count(second, '/timesheet-headers')).toBeGreaterThan(0)
    // The baseline itself: a change that adds a request per tool call fails here.
    expect(first.length).toBeLessThanOrEqual(8)
    expect(second.length).toBeLessThanOrEqual(4)
  } finally {
    lifetime.abort()
    await temp.close()
  }
})

function summary(paths: string[]): string {
  const counts = new Map<string, number>()
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1)
  return [...counts].map(([path, n]) => `${path}×${n}`).join(', ')
}
