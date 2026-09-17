import type { OryhMcpClient } from '@oryh/ai-client-core'
import { desktopSkillService } from '@oryh/ai-client-core'
import { installPaneTools, PANE_TOOLS, PaneService, UserViewRegistry } from '@oryh/dsh-pane'
import {
  connectionId,
  fakeConnection,
  fakeContext,
  fakeController,
  paneSyncer,
  pending,
  tempDirectory,
  until,
  vi,
} from '@oryh/dsh-pane/testing'
import type { NavigationCommand } from '@oryh/dsh-pane/types'
import { describe, expect, it } from 'vitest'
import { BusinessAgent } from '../src/business-agent.js'

interface Options {
  connections?: number
  holder?: {
    origin: string
    tenantId: string
    userId: string
    employeeId: string
    tenantName: string
    email: string
  } | null
  mcpTools?: { name: string; readOnly: boolean; isError?: boolean }[]
  capabilities?: { shell: boolean; writes: boolean }
  answer?: (args: Record<string, unknown>) => string
  permissions?: string[]
}

/**
 * The agent over a pane with two page contributions standing in for the page plugins: the todo list,
 * which opens by page, and timesheets, which open a record by id through their own opener.
 */
async function setup(options: Options = {}) {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const connection = options.permissions ? fakeConnection(options.permissions) : fakeConnection()
  const { controller } = fakeController(connection, options.connections ?? 1)
  const host = { forgetVerifications: vi.fn() }
  const pane = new PaneService(harness.ctx, controller, temp.directory, new UserViewRegistry(harness.ctx))
  installPaneTools(harness.ctx, pane)
  pane.contribute({ name: 'oryh-pane', tools: [...PANE_TOOLS] })
  pane.contribute({
    name: 'todos',
    resources: { todos: 'my-open-todos' },
    prompt: ['待办规则'],
    tools: ['oryh_open_todo'],
  })
  const openTimesheet = vi.fn(async () => {})
  pane.contribute({ name: 'timesheets', resources: { 'timesheet-headers': 'timesheets' }, open: openTimesheet })
  const sync = vi.fn(async () => ({ installed: true, root: '/skills', skills: [], message: '已安装。' }))
  const skills = desktopSkillService({ sync, installedPrincipal: () => options.holder ?? null })
  const callTool = vi.fn(async (_c: string, name: string, args: Record<string, unknown>) => {
    const tool = options.mcpTools?.find(t => t.name === name)
    return {
      text: tool?.isError ? '{"detail":"refused"}' : (options.answer?.(args) ?? '{"data":[]}'),
      isError: Boolean(tool?.isError),
    }
  })
  const mcp = {
    tools: async () =>
      (options.mcpTools ?? []).map(t => ({
        name: t.name,
        description: t.name,
        inputSchema: { type: 'object', properties: {} },
        readOnly: t.readOnly,
      })),
    callTool,
  } as unknown as OryhMcpClient
  const agent = new BusinessAgent(harness.ctx, {
    controller,
    host,
    pane,
    skills,
    mcp,
    capabilities: options.capabilities ?? { shell: true, writes: true },
  })
  agent.install()
  const exec = { agent: { id: 's' }, callId: 'call-1', signal: new AbortController().signal }
  return {
    ...harness,
    agent,
    pane,
    host,
    connection,
    exec,
    sync,
    callTool,
    openTimesheet,
    page: paneSyncer(pane),
    bind: () => pane.bind({ sessionId: 's', connectionId }),
    navigation: () => pending(pane) as NavigationCommand | undefined,
    /** An agent as the runtime creates it, with the tool policy it is given recorded. */
    created: () => {
      const policies: { allow: string[]; lifted: boolean }[] = []
      const agentCtx = {
        tools: {
          restrict: (filter: { allow: string[] }) => {
            const policy = { allow: filter.allow, lifted: false }
            policies.push(policy)
            return () => {
              policy.lifted = true
            }
          },
          presentAs: () => () => {},
        },
        systemPrompt: { context: () => () => {} },
      }
      harness.emit('agent/created', { agent: { id: 's', ctx: agentCtx } })
      return policies
    },
    /** A tool call finishing, through the same waterfall the tool runtime drives. */
    ran: async (name: string) => {
      for (const fn of harness.listeners.get('tools/post-execute') ?? [])
        await (fn as unknown as (e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>)(
          { name, agent: { id: 's' } },
          {},
          async () => ({ kind: 'accept' }),
        )
    },
    status: (status: string) => harness.emit('agent/status', { agent: { id: 's', inbox: { nextTurn: [] } }, status }),
    denied: async (name: string) => {
      let result: unknown
      for (const fn of harness.listeners.get('tools/pre-execute') ?? [])
        result = await (fn as unknown as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>)(
          { name, agent: { id: 's' } },
          async () => ({ kind: 'allow' }),
        )
      return result as { kind: string; reason?: string }
    },
    close: temp.close,
  }
}

describe('the agent as the primary client', () => {
  const principal = {
    origin: 'https://oryh.example',
    tenantId: 'tenant',
    userId: 'user',
    employeeId: 'employee',
    tenantName: '晶诚',
    email: 'hua@example.invalid',
  }
  it('offers what the pages contributed, and follows their changes', async () => {
    const f = await setup()
    try {
      const policies = f.created()
      expect(policies[0]!.allow).toEqual(['skill', 'bash', 'oryh_skill_sync', ...PANE_TOOLS, 'oryh_open_todo'])
      expect(f.prompt()).toContain('待办规则')
      const remove = f.pane.contribute({ name: 'later', tools: ['oryh_later'] })
      expect(policies.at(-1)!.allow).toContain('oryh_later')
      expect(policies.slice(0, -1).every(policy => policy.lifted)).toBe(true)
      remove()
      expect(policies.at(-1)!.allow).not.toContain('oryh_later')
    } finally {
      await f.close()
    }
  })
  it('on a read-only server without a shell, never offers bash and tells the agent it cannot write', async () => {
    const f = await setup({ capabilities: { shell: false, writes: false } })
    try {
      const [policy] = f.created()
      expect(policy!.allow).not.toContain('bash')
      expect(policy!.allow).toContain('skill')
      expect((await f.denied('bash')).kind).toBe('deny')
      expect(f.prompt()).toMatch(/目前只读/)
      expect(f.prompt()).not.toMatch(/bash 只用于/)
    } finally {
      await f.close()
    }
    const desktop = await setup()
    try {
      expect(desktop.created()[0]!.allow).toContain('bash')
      expect(desktop.prompt()).not.toMatch(/目前只读/)
    } finally {
      await desktop.close()
    }
  })
  it('syncs skills for the only enterprise when no page is bound, and asks when there are several', async () => {
    const one = await setup({ connections: 1 })
    try {
      await one.tool('oryh_skill_sync').execute({}, one.exec)
      expect(one.sync).toHaveBeenCalledWith(connectionId, true)
    } finally {
      await one.close()
    }
    const two = await setup({ connections: 2 })
    try {
      await expect(two.tool('oryh_skill_sync').execute({}, two.exec)).rejects.toThrow(/多个企业连接/)
      expect(two.sync).not.toHaveBeenCalled()
    } finally {
      await two.close()
    }
  })
  it('tells the agent whose skills it would write with, and whether that is this session enterprise', async () => {
    const none = await setup()
    try {
      expect(none.agent.skillIdentity('s')).toMatch(/oryh_skill_sync/)
    } finally {
      await none.close()
    }
    const same = await setup({ holder: principal })
    try {
      expect(same.agent.skillIdentity('s')).toContain('属于：晶诚 · hua@example.invalid。')
      await same.bind()
      expect(same.agent.skillIdentity('s')).toMatch(/身份一致/)
    } finally {
      await same.close()
    }
    // After switching accounts the bundle can belong to someone else: the agent must not write with it.
    const other = await setup({ holder: { ...principal, userId: 'someone-else', email: 'other@example.invalid' } })
    try {
      await other.bind()
      expect(other.agent.skillIdentity('s')).toMatch(/不一致.*oryh_skill_sync/)
    } finally {
      await other.close()
    }
  })
  it('moves the server-change marker when a turn that ran the shell ends, and only then', async () => {
    const f = await setup()
    const marker = () => f.pane.frame('s').state.serverChange
    try {
      await f.ran('oryh_current_page')
      f.status('idle')
      expect(marker()).toBeUndefined()
      await f.ran('bash')
      f.status('running')
      expect(marker()).toBeUndefined()
      f.status('idle')
      const first = marker()
      expect(first).toBeDefined()
      // An idle that follows a turn with no shell leaves it alone; the next shell turn moves it again.
      f.status('idle')
      expect(marker()).toEqual(first)
      await f.ran('bash')
      f.status('idle')
      expect(marker()?.id).not.toBe(first!.id)
    } finally {
      await f.close()
    }
  })
  it('starts every turn from the truth: verifications are forgotten when the agent starts running', async () => {
    const f = await setup()
    try {
      f.status('idle')
      expect(f.host.forgetVerifications).not.toHaveBeenCalled()
      f.status('running')
      expect(f.host.forgetVerifications).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  })
  it('never tells the agent that a write has to be confirmed on the page', async () => {
    const f = await setup()
    try {
      const decision = await f.denied('some_other_tool')
      expect(decision.kind).toBe('deny')
      expect(decision.reason).not.toMatch(/页面/)
    } finally {
      await f.close()
    }
  })
  it('shows what the agent reads, whichever ORYH tool it used, and stays put for one record', async () => {
    // The answer decides: a list moves the pane, a single record does not.
    const answer = (args: Record<string, unknown>) =>
      JSON.stringify(String(args.path ?? args.resource ?? '').includes('/abc') ? { data: { id: 'abc' } } : { data: [] })
    const f = await setup({
      mcpTools: [
        { name: 'oryh_request', readOnly: true },
        { name: 'oryh_list', readOnly: true },
      ],
      answer,
    })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      f.page.sync('my-open-todos')
      // One record, data with no page of its own, or the page already shown: no reason to move the pane.
      await f.tool('oryh_request').execute({ method: 'GET', path: '/todos/abc' }, f.exec)
      await f.tool('oryh_request').execute({ method: 'GET', path: '/workflow-definitions' }, f.exec)
      await f.tool('oryh_request').execute({ method: 'GET', path: '/todos' }, f.exec)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(f.navigation()).toBeUndefined()
      // Another tool with parameters of its own reaches the same page: the resource is what matters.
      f.page.sync('list-projects')
      await f.tool('oryh_list').execute({ resource: 'todos', status: 'open' }, f.exec)
      await until(() => f.navigation()?.payload.page === 'my-open-todos')
      expect(f.navigation()?.payload).toMatchObject({ target: 'page', page: 'my-open-todos' })
    } finally {
      await f.close()
    }
  })
  it('opens what the agent wrote through the page that owns the record', async () => {
    const f = await setup({
      mcpTools: [{ name: 'oryh_request', readOnly: false }],
      answer: () => '{"data":{"id":"th-9"}}',
      permissions: ['timesheet.submit_own'],
    })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      f.page.sync('list-projects')
      await f.tool('oryh_request').execute({ method: 'POST', path: '/timesheet-headers/th-9/submit', body: {} }, f.exec)
      await until(() => f.openTimesheet.mock.calls.length > 0)
      expect(f.openTimesheet).toHaveBeenCalledWith('s', 'timesheet-headers', 'th-9')
    } finally {
      await f.close()
    }
  })
  it("offers ORYH's MCP tools as listed by the server, over the session enterprise, without shadowing its own", async () => {
    const f = await setup({
      mcpTools: [
        { name: 'oryh_request', readOnly: false },
        { name: 'oryh_get', readOnly: true },
        { name: 'oryh_current_page', readOnly: true },
        { name: 'bad/name', readOnly: true },
      ],
    })
    try {
      const policies = f.created()
      expect(policies.at(-1)?.allow).not.toContain('oryh_request')
      await f.agent.mcpTools.refresh(connectionId)
      // Listed from the server, not named in code; a Host tool name and a malformed one are not taken.
      expect([...f.agent.mcpTools.names].sort()).toEqual(['oryh_get', 'oryh_request'])
      // The agent's allow-list grows: the wider policy goes on before the narrower one comes off.
      expect(policies.at(-1)?.allow).toEqual(expect.arrayContaining(['oryh_request', 'oryh_get', 'skill']))
      expect(policies.slice(0, -1).every(policy => policy.lifted)).toBe(true)
      expect((await f.denied('oryh_request')).kind).toBe('allow')
      // A read-only call runs over the session's enterprise and leaves the pane alone.
      expect(await f.tool('oryh_get').execute({}, f.exec)).toBe('{"data":[]}')
      expect(f.callTool).toHaveBeenCalledWith(
        connectionId,
        'oryh_get',
        {},
        { operation: { kind: 'chat', operationId: expect.any(String), sessionId: 's', callId: 'call-1' } },
      )
      f.status('idle')
      expect(f.pane.frame('s').state.serverChange).toBeUndefined()
      // A call that may write marks the turn, and the pane re-reads when it ends.
      await f.tool('oryh_request').execute({ method: 'POST', path: '/timesheet-headers/h/submit' }, f.exec)
      f.status('idle')
      expect(f.pane.frame('s').state.serverChange).toBeDefined()
    } finally {
      await f.close()
    }
  })
  it('lets the model see an ORYH refusal as a failure, and does not mark it as a write', async () => {
    const f = await setup({ mcpTools: [{ name: 'oryh_request', readOnly: false, isError: true }] })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      await expect(f.tool('oryh_request').execute({ method: 'POST', path: '/x' }, f.exec)).rejects.toThrow(/refused/)
      f.status('idle')
      expect(f.pane.frame('s').state.serverChange).toBeUndefined()
    } finally {
      await f.close()
    }
  })
})
