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
  /** What ORYH says when a tool marked `isError` refuses. */
  refusal?: string
  permissions?: string[]
  /** Offer the files the person attaches in Chat, over a fake store and uploader. */
  attachments?: boolean
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
  pane.contribute({ name: 'shipments', resources: { 'timesheet-headers': 'shipments' }, open: openTimesheet })
  const sync = vi.fn(async () => ({ installed: true, root: '/skills', skills: [], message: '已安装。' }))
  const skills = desktopSkillService({ sync, installedPrincipal: () => options.holder ?? null })
  const callTool = vi.fn(async (_c: string, name: string, args: Record<string, unknown>) => {
    const tool = options.mcpTools?.find(t => t.name === name)
    return {
      text: tool?.isError ? (options.refusal ?? '{"detail":"refused"}') : (options.answer?.(args) ?? '{"data":[]}'),
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
  const upload = vi.fn(async (_c: string, file: { filename: string; contentType: string; data: Uint8Array }) => ({
    id: `att-${file.filename}`,
    filename: file.filename,
    sha256: 'digest',
    sizeBytes: file.data.byteLength,
    alreadyExisted: file.contentType.startsWith('image/'),
  }))
  const files = {
    readImage: vi.fn(async () => ({ data: new Uint8Array([255, 216, 255]) })),
    async *readFileStream() {
      yield new Uint8Array([37, 80])
      yield new Uint8Array([68, 70])
    },
  }
  const agent = new BusinessAgent(harness.ctx, {
    controller,
    host,
    pane,
    skills,
    mcp,
    capabilities: options.capabilities ?? { shell: true, writes: true },
    ...(options.attachments ? { attachments: { files, uploader: { upload } } } : {}),
  })
  agent.install()
  const exec = { agent: { id: 's' }, callId: 'call-1', signal: new AbortController().signal }
  return {
    ...harness,
    agent,
    pane,
    host,
    connection,
    controller,
    exec,
    sync,
    callTool,
    upload,
    files,
    openTimesheet,
    page: paneSyncer(pane),
    bind: () => pane.bind({ sessionId: 's', connectionId }),
    navigation: () => pending(pane) as NavigationCommand | undefined,
    /** An agent as the runtime creates it, with the tool policy it is given recorded. */
    created: async () => {
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
      const created = { id: 's', ctx: agentCtx }
      await harness.emit('agent/created', { agent: created, source: 'startup' })
      return Object.assign(policies, { dispose: () => harness.emit('agent/disposed', { agent: created }) })
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
      const policies = await f.created()
      expect(policies[0]!.allow).toEqual([
        'skill',
        'bash',
        'oryh_skill_sync',
        'oryh_skill_file',
        'ask_user_question',
        // With a shell come the tools that read and stop the background work it starts.
        'job_output',
        'job_list',
        'job_kill',
        ...PANE_TOOLS,
        'oryh_open_todo',
      ])
      expect(f.prompt()).toContain('待办规则')
      const remove = f.pane.contribute({ name: 'later', prompt: '后来的规则', tools: ['oryh_later'] })
      expect(policies.at(-1)!.allow).toContain('oryh_later')
      expect(policies.slice(0, -1).every(policy => policy.lifted)).toBe(true)
      // The rules follow as the tools do: the agent is not allowed a tool its prompt never mentions.
      expect(f.prompt()).toContain('后来的规则')
      remove()
      expect(policies.at(-1)!.allow).not.toContain('oryh_later')
      expect(f.prompt()).not.toContain('后来的规则')
    } finally {
      await f.close()
    }
  })
  it('leaves a name nothing registered out of the policy, and keeps the policy', async () => {
    const f = await setup()
    try {
      // A page plugin names a tool that never registered. Harness refuses a restriction that names a tool
      // it does not have, whole: the agent used to be left with no restriction at all.
      f.missing.add('oryh_never_registered')
      f.pane.contribute({ name: 'careless', tools: ['oryh_never_registered', 'oryh_real'] })
      const policies = await f.created()
      expect(policies).toHaveLength(1)
      expect(policies[0]!.allow).toContain('oryh_real')
      expect(policies[0]!.allow).not.toContain('oryh_never_registered')
    } finally {
      await f.close()
    }
  })

  it("keeps a tool only the session's preset has, such as the buttons a write is confirmed with", async () => {
    const f = await setup()
    try {
      // `ask_user_question` is put on per preset: it is in no global list, and the agent has it all the same.
      f.presetOnly.add('ask_user_question')
      const policies = await f.created()
      expect(policies[0]!.allow).toContain('ask_user_question')
    } finally {
      await f.close()
    }
  })

  it('refuses in a guard what it refuses in the waterfall, so a listener ahead of it cannot let a call through', async () => {
    const f = await setup()
    try {
      await f.created()
      expect(f.guards).toHaveLength(1)
      const guard = f.guards[0]!
      expect(guard({ name: 'read', agent: { id: 's' }, arguments: {} })).toContain(
        '不在 ORYH 客户端为本会话开放的工具中',
      )
      expect(guard({ name: 'oryh_open_todo', agent: { id: 's' }, arguments: {} })).toBeUndefined()
      expect(guard({ name: 'oryh_open_todo', arguments: {} })).toContain('不在 ORYH 客户端')
    } finally {
      await f.close()
    }
  })

  it('takes its policy and listeners off an agent that is disposed, and off that one only', async () => {
    const f = await setup()
    try {
      // A custom page's refresh is an agent made and disposed each time; the Chat beside it lives on.
      const run = await f.created()
      const chat = await f.created()
      await run.dispose()
      expect(run.every(policy => policy.lifted)).toBe(true)
      const before = run.length
      const remove = f.pane.contribute({ name: 'later', tools: ['oryh_later'] })
      // The disposed one is not given a policy again; the live one follows the change as before.
      expect(run).toHaveLength(before)
      expect(chat.at(-1)!.allow).toContain('oryh_later')
      expect(chat.at(-1)!.lifted).toBe(false)
      remove()
    } finally {
      await f.close()
    }
  })

  it('on a read-only server without a shell, never offers bash and tells the agent it cannot write', async () => {
    const f = await setup({ capabilities: { shell: false, writes: false } })
    try {
      const [policy] = await f.created()
      expect(policy!.allow).not.toContain('bash')
      expect(policy!.allow).toContain('skill')
      expect((await f.denied('bash')).kind).toBe('deny')
      // No shell, so no background work to read or stop either.
      for (const name of ['job_output', 'job_list', 'job_kill']) {
        expect(policy!.allow).not.toContain(name)
        expect((await f.denied(name)).kind).toBe('deny')
      }
      expect(f.prompt()).toMatch(/目前只读/)
      expect(f.prompt()).not.toMatch(/bash 只用于/)
    } finally {
      await f.close()
    }
    const desktop = await setup()
    try {
      expect((await desktop.created())[0]!.allow).toContain('bash')
      expect((await desktop.created())[0]!.allow).toEqual(
        expect.arrayContaining(['job_output', 'job_list', 'job_kill']),
      )
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
      await f.tool('oryh_request').execute({ method: 'GET', path: '/business-rules' }, f.exec)
      await f.tool('oryh_request').execute({ method: 'GET', path: '/todos' }, f.exec)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(f.navigation()).toBeUndefined()
      // Another tool with parameters of its own reaches the same page: the resource is what matters.
      f.page.sync('inventory-item-details')
      await f.tool('oryh_list').execute({ resource: 'todos', status: 'open' }, f.exec)
      await until(() => f.navigation()?.payload.page === 'my-open-todos')
      expect(f.navigation()?.payload).toMatchObject({ target: 'page', page: 'my-open-todos' })
    } finally {
      await f.close()
    }
  })
  it('shows a list narrowed as the agent read it, where the page can narrow itself that way', async () => {
    const f = await setup({
      mcpTools: [
        { name: 'oryh_request', readOnly: true },
        { name: 'oryh_list', readOnly: true },
      ],
    })
    try {
      f.pane.contribute({
        name: 'records',
        resources: { 'sales-orders': 'sales-orders' },
        opensRecords: true,
        narrows: true,
      })
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      const list = (page: string) => ({ key: `${page}:list`, title: page, detail: '', scope: '' })
      // From another list: there in one step, with the conditions of the read and not its paging.
      f.page.sync('my-open-todos', list('my-open-todos'))
      await f
        .tool('oryh_list')
        .execute({ collection: 'sales-orders', filters: { status: 'shipped', page: 2, order_by: '-id' } }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toEqual({
        target: 'filters',
        page: 'sales-orders',
        queryValues: { status: 'shipped' },
      })
      // On that list already: it is narrowed where it stands. The path's own query string counts too.
      f.page.ack('navigation', 'sales-orders', list('sales-orders'))
      await f
        .tool('oryh_request')
        .execute({ method: 'GET', path: '/sales-orders?customer_id=c-1', query: { status: 'draft' } }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({
        target: 'filters',
        queryValues: { customer_id: 'c-1', status: 'draft' },
      })
      f.page.ack('navigation', 'sales-orders', list('sales-orders'))
      // Read whole, it is left as the person has it; a page that cannot narrow itself is only shown.
      await f.tool('oryh_list').execute({ collection: 'sales-orders' }, f.exec)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(f.navigation()).toBeUndefined()
      await f.tool('oryh_list').execute({ collection: 'todos', filters: { status: 'open' } }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toEqual({ target: 'page', page: 'my-open-todos' })
    } finally {
      await f.close()
    }
  })
  it('follows someone who is browsing, and leaves alone whatever a person has open', async () => {
    const f = await setup({ mcpTools: [{ name: 'oryh_list', readOnly: true }] })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      const read = () => f.tool('oryh_list').execute({ resource: 'timesheet-headers' }, f.exec)
      const stays = async () => {
        await read()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(f.navigation()).toBeUndefined()
      }
      // A custom page: reading what it is built from, or anything else, answers the question; the page stays.
      const content = JSON.stringify({ id: 'p1', result: { sources: [{ collection: 'todos', total: 3 }] } })
      f.page.sync('analytics', { key: 'custom:p1', title: '订单统计', detail: '', scope: '', content })
      await f.tool('oryh_list').execute({ resource: 'todos', status: 'open' }, f.exec)
      await stays()
      // A document open on a list page, and a form: the same.
      f.page.sync('sales-orders', { key: 'sales-orders:so-7', title: 'SO-7', detail: '', scope: '' })
      await stays()
      f.page.sync('inventory-item-details', {
        key: 'inventory-item-details:new',
        title: '新建项目',
        detail: '',
        scope: '',
      })
      await stays()
      // A list is a place to move on from.
      f.page.sync('sales-orders', { key: 'sales-orders:list', title: '销售订单', detail: '', scope: '' })
      await read()
      await until(() => f.navigation()?.payload.page === 'shipments')
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
      f.page.sync('inventory-item-details')
      await f.tool('oryh_request').execute({ method: 'POST', path: '/timesheet-headers/th-9/submit', body: {} }, f.exec)
      await until(() => f.openTimesheet.mock.calls.length > 0)
      expect(f.openTimesheet).toHaveBeenCalledWith('s', 'timesheet-headers', 'th-9')
    } finally {
      await f.close()
    }
  })
  it('opens the one record the agent read or wrote, where a page can show a record by id', async () => {
    const order = '2df5ffdc-2924-4978-8ab1-ac335733d941'
    const written = '95db660e-1081-4cbd-852a-af2a1425dc7b'
    const f = await setup({
      mcpTools: [{ name: 'oryh_request' }],
      // A detail answers with the document and its tables, and no id of its own; a create answers with one.
      answer: args =>
        args.method === 'POST'
          ? JSON.stringify({ data: { id: written } })
          : args.lookup
            ? JSON.stringify({ data: [{ id: order }] })
            : args.counting
              ? JSON.stringify({ data: [{ id: order }], meta: { total: 4, page: 1, size: 1 } })
              : '{"data":{"order":{}}}',
    })
    const list = (page: 'my-open-todos' | 'sales-orders') => ({
      key: `${page}:list`,
      title: page,
      detail: '',
      scope: '',
    })
    const opened = (id: string) => ({ key: `sales-orders:${id}`, title: 'SO', detail: '', scope: '' })
    const settle = async (id: string) => {
      await until(() => f.navigation()?.payload.recordId === id)
      expect(f.navigation()?.payload).toEqual({ target: 'record', page: 'sales-orders', recordId: id })
      f.page.ack('navigation', 'sales-orders', opened(id))
      await until(() => f.navigation() === undefined)
    }
    const quiet = async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(f.navigation()).toBeUndefined()
    }
    try {
      f.pane.contribute({ name: 'records', resources: { 'sales-orders': 'sales-orders' }, opensRecords: true })
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      // From another page's list, a record read to answer a question opens beside the answer, behind
      // Chat on a narrow screen. Read by its path:
      f.page.sync('my-open-todos', list('my-open-todos'))
      await f.tool('oryh_request').execute({ method: 'GET', path: `/sales-orders/${order}/detail` }, f.exec)
      await settle(order)
      // by ORYH's own detail tool, which names the collection and the id apart:
      f.page.sync('my-open-todos', list('my-open-todos'))
      await f.tool('oryh_request').execute({ method: 'GET', resource: 'sales-orders', id: order }, f.exec)
      await settle(order)
      // and looked up by its number, when the document comes back as a list of one.
      f.page.sync('my-open-todos', list('my-open-todos'))
      await f.tool('oryh_request').execute({ method: 'GET', path: '/sales-orders?order_no=SO-1', lookup: true }, f.exec)
      await settle(order)
      // One row of four is not the document. The agent read a page of one to count them, and what the
      // pane shows is the list it counted — where it used to open the first of the four.
      f.page.sync('my-open-todos', list('my-open-todos'))
      await f
        .tool('oryh_request')
        .execute({ method: 'GET', path: '/sales-orders?status=confirmed&page=1&size=1', counting: true }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({ target: 'page', page: 'sales-orders' })
      // The person then opens that order from the list, which is where the next step finds them.
      f.page.ack('navigation', 'sales-orders', opened(order))
      await until(() => f.navigation() === undefined)
      // Someone with a document open is looking at that document: another one read on the way stays in Chat.
      await f.tool('oryh_request').execute({ method: 'GET', path: `/sales-orders/${written}/detail` }, f.exec)
      await quiet()
      // So does someone looking at this very list: they asked for the list.
      f.page.sync('sales-orders', list('sales-orders'))
      await f.tool('oryh_request').execute({ method: 'GET', path: `/sales-orders/${order}/detail` }, f.exec)
      await quiet()
      // What the agent wrote is another matter: the new record itself opens, not the list it may be
      // filtered out of (R2-21), whatever the pane showed.
      await f.tool('oryh_request').execute({ method: 'POST', path: '/sales-orders', body: {} }, f.exec)
      await until(() => f.navigation()?.payload.recordId === written)
      f.page.ack('navigation', 'sales-orders', opened(written))
      await until(() => f.navigation() === undefined)
      // Unless the person is typing somewhere: then nothing opens over it, neither the record nor its list.
      f.page.sync('analytics', { key: 'custom:form-1', title: '登记', detail: '', scope: '', unsaved: true })
      await f.tool('oryh_request').execute({ method: 'POST', path: '/sales-orders', body: {} }, f.exec)
      await quiet()
    } finally {
      await f.close()
    }
  })
  it('stays on the todo when the agent approves the timesheet that todo is about', async () => {
    // Approving an employee's timesheet from the todo that asked for it moved the pane to "我的工时",
    // the page that owns timesheets: away from the todo, onto a list of the approver's own timesheets.
    const f = await setup({
      mcpTools: [{ name: 'oryh_request', readOnly: false }],
      answer: () => '{"data":{"id":"ar-1"}}',
      permissions: ['timesheet.submit_own', 'approval.record'],
    })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      const todo = { key: 'my-open-todos:todo-1', title: '审批工时', detail: '', scope: '' }
      f.page.sync('my-open-todos', { ...todo, subject: { type: 'timesheet_header', id: 'th-9' } })
      await f.tool('oryh_request').execute(
        {
          method: 'POST',
          path: '/timesheet-headers/th-9/approve',
          body: { entity_type: 'timesheet_header', entity_id: 'th-9', action: 'approved' },
        },
        f.exec,
      )
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(f.openTimesheet).not.toHaveBeenCalled()
      expect(f.navigation()).toBeUndefined()
      // A write about something else is still shown: the person asked for a new thing.
      await f.tool('oryh_request').execute({ method: 'POST', path: '/timesheet-headers/th-7/submit', body: {} }, f.exec)
      await until(() => f.openTimesheet.mock.calls.length > 0)
    } finally {
      await f.close()
    }
  })
  it("gives a chat write ORYH's idempotency key, over any the model wrote, and leaves reads alone", async () => {
    const f = await setup({
      mcpTools: [
        { name: 'oryh_request', readOnly: false },
        { name: 'oryh_get', readOnly: true },
      ],
    })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      await f.tool('oryh_request').execute({ path: '/projects', idempotency_key: 'from-the-model' }, f.exec)
      await f.tool('oryh_get').execute({ path: '/projects' }, f.exec)
      const [write, read] = f.callTool.mock.calls
      const key = (write![2] as Record<string, unknown>).idempotency_key
      expect(key).toBe((write![3] as { operation: { operationId: string } }).operation.operationId)
      expect(key).not.toBe('from-the-model')
      expect(read![2]).not.toHaveProperty('idempotency_key')
    } finally {
      await f.close()
    }
  })
  it('tells a conversation that rules it read have changed since, until it reads them again', async () => {
    // Only the clock is ours: a rule is asked about again no sooner than half a minute after it was read.
    vi.useFakeTimers({ toFake: ['Date'] })
    let version = 3
    const rules = { method: 'GET', path: '/business-rules?kind=data_rule&object_type=sales_order' }
    const f = await setup({
      mcpTools: [{ name: 'oryh_request', readOnly: false }],
      answer: args =>
        String(args.path).includes('/business-rules')
          ? JSON.stringify({ data: [{ id: 'r-1', version, status: 'published', body: `要求第 ${version} 版` }] })
          : '{"data":[]}',
    })
    try {
      const contexts = new Map<string, () => string>()
      const agentCtx = {
        tools: { restrict: () => () => {}, presentAs: () => () => {} },
        systemPrompt: {
          context: (spec: { name: string; text: () => string }) => {
            contexts.set(spec.name, spec.text)
            return () => {}
          },
        },
      }
      await f.emit('agent/created', { agent: { id: 's', ctx: agentCtx }, source: 'startup' })
      const said = () => contexts.get('oryh-rules-changed')!()
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      await f.tool('oryh_request').execute(rules, f.exec)
      expect(said()).toBe('')
      // An admin publishes a new version while the conversation goes on; a later turn starts.
      version = 4
      vi.setSystemTime(Date.now() + 60_000)
      f.status('running')
      let reachedModel = false
      for (const listener of f.listeners.get('agent/pre-step') ?? []) {
        await (listener as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)(
          { agent: { id: 's' }, step: 1, signal: new AbortController().signal },
          async () => {
            expect(said()).toContain('已经作废')
            reachedModel = true
            return { kind: 'enter', messages: [] }
          },
        )
      }
      expect(reachedModel).toBe(true)
      expect(said()).toContain('object_type=sales_order')
      // Asked the way the agent asked, as a read: nothing of a write goes with it.
      const again = f.callTool.mock.calls.at(-1)!
      expect(again[1]).toBe('oryh_request')
      expect(again[2]).toEqual(rules)
      expect(again[3]).not.toHaveProperty('operation')
      // The agent reads the rules again, and is told no more.
      await f.tool('oryh_request').execute(rules, f.exec)
      expect(said()).toBe('')
      // The standing rule says the same in general, for a change nobody could have seen.
      expect(f.agent.instructions()).toContain('不沿用本会话早些时候读到的内容')
    } finally {
      vi.useRealTimers()
      await f.close()
    }
  })
  it('takes a read for a read when the server marks no tool read-only', async () => {
    // As ORYH lists them today: no tool carries readOnlyHint.
    const f = await setup({
      mcpTools: [
        { name: 'oryh_get', readOnly: false },
        { name: 'oryh_request', readOnly: false },
      ],
      answer: () => '{"data":{"id":"abc"}}',
    })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      await f.bind()
      await f.tool('oryh_get').execute({ collection: 'timesheet-headers', id: 'abc' }, f.exec)
      await f.tool('oryh_request').execute({ method: 'get', path: '/timesheet-headers/abc' }, f.exec)
      f.status('idle')
      const [get, request] = f.callTool.mock.calls
      expect(get![2]).not.toHaveProperty('idempotency_key')
      expect(request![2]).not.toHaveProperty('idempotency_key')
      // Nothing written: no page is told to re-read, and the record read is not opened as if written.
      expect(f.pane.frame('s').state.serverChange).toBeUndefined()
      expect(f.openTimesheet).not.toHaveBeenCalled()
      await f.tool('oryh_request').execute({ method: 'POST', path: '/timesheet-headers/abc/submit' }, f.exec)
      f.status('idle')
      expect(f.pane.frame('s').state.serverChange).toBeDefined()
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
      const policies = await f.created()
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
        {
          operation: { kind: 'chat', operationId: expect.any(String), sessionId: 's', callId: 'call-1' },
          signal: f.exec.signal,
        },
      )
      f.status('idle')
      expect(f.pane.frame('s').state.serverChange).toBeUndefined()
      // A call that may write marks the turn, and the pane re-reads when it ends.
      await f.tool('oryh_request').execute({ method: 'POST', path: '/timesheet-headers/h/submit' }, f.exec)
      f.status('idle')
      expect(f.pane.frame('s').state.serverChange).toBeDefined()
      // Which record it wrote goes with the marker, once, for a page showing it to point out.
      const id = '11111111-2222-4333-8444-555555555555'
      for (const path of [`/todos/${id}`, `/todos/${id}/complete`])
        await f.tool('oryh_request').execute({ method: 'POST', path }, f.exec)
      f.status('idle')
      expect(f.pane.frame('s').state.serverChange?.records).toEqual([{ collection: 'todos', id }])
    } finally {
      await f.close()
    }
  })
  it('lists ORYH tools for a session whose enterprise was connected after the Host started', async () => {
    const f = await setup({ connections: 0, mcpTools: [{ name: 'oryh_request', readOnly: false }] })
    try {
      // A desktop container starts before its owner signs in: at startup there is nothing to list through.
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(f.agent.mcpTools.names.size).toBe(0)
      f.controller.listConnections = async () => [f.connection]
      const policies = await f.created()
      await until(() => f.agent.mcpTools.names.has('oryh_request'))
      expect(policies.at(-1)?.allow).toContain('oryh_request')
      expect((await f.denied('oryh_request')).kind).toBe('allow')
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
  it("gives a page plugin's own run its tools and none of the Chat's, and never the Chat those tools", async () => {
    const f = await setup({ mcpTools: [{ name: 'oryh_request', readOnly: false }] })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      f.pane.contribute({
        name: 'pages',
        tools: ['oryh_page_save'],
        runner: { tools: ['oryh_run_read', 'oryh_run_publish'], owns: id => id === 'run-1' },
      })
      const policy = async (id: string) => {
        const allowed: string[][] = []
        const agentCtx = {
          tools: {
            restrict: (filter: { allow: string[] }) => (allowed.push(filter.allow), () => {}),
            presentAs: () => () => {},
          },
          systemPrompt: { context: vi.fn(() => () => {}) },
        }
        await f.emit('agent/created', { agent: { id, ctx: agentCtx }, source: 'startup' })
        return { allow: allowed.at(-1)!, contexts: agentCtx.systemPrompt.context.mock.calls.length }
      }
      const decide = async (id: string, name: string) => {
        let result: { kind: string } | undefined
        for (const fn of f.listeners.get('tools/pre-execute') ?? [])
          result = await (fn as unknown as (e: unknown, n: () => Promise<unknown>) => Promise<{ kind: string }>)(
            { name, agent: { id } },
            async () => ({ kind: 'allow' }),
          )
        return result?.kind
      }
      const chat = await policy('s')
      expect(chat.allow).toContain('oryh_page_save')
      expect(chat.allow).not.toContain('oryh_run_read')
      const run = await policy('run-1')
      expect(run.allow).toEqual(['oryh_run_read', 'oryh_run_publish'])
      // The run is not told about the Chat's page or skills.
      expect(run.contexts).toBe(0)
      expect(await decide('s', 'oryh_run_read')).toBe('deny')
      expect(await decide('run-1', 'oryh_run_read')).toBe('allow')
      expect(await decide('run-1', 'oryh_request')).toBe('deny')
      expect(await decide('run-1', 'bash')).toBe('deny')
    } finally {
      await f.close()
    }
  })
  it("lets a plugin's run that reads ORYH make the server's reads and none of its writes, and keeps the pane still", async () => {
    const f = await setup({
      mcpTools: [
        { name: 'oryh_request', readOnly: false },
        { name: 'oryh_list', readOnly: true },
      ],
    })
    try {
      await f.agent.mcpTools.refresh(connectionId)
      f.pane.contribute({
        name: 'review',
        runner: { tools: ['skill', 'oryh_review_result'], reads: true, owns: id => id === 'review-1' },
      })
      const allowed: string[][] = []
      const agentCtx = {
        tools: {
          restrict: (filter: { allow: string[] }) => (allowed.push(filter.allow), () => {}),
          presentAs: () => () => {},
        },
        systemPrompt: { context: vi.fn(() => () => {}) },
      }
      await f.emit('agent/created', { agent: { id: 'review-1', ctx: agentCtx }, source: 'startup' })
      // Its own tools, and ORYH's — but not the Chat's: no shell, no page tools.
      expect([...allowed.at(-1)!].sort()).toEqual(['oryh_list', 'oryh_request', 'oryh_review_result', 'skill'])
      const decide = async (name: string, args: unknown) => {
        let result: { kind: string; reason?: string } | undefined
        for (const fn of f.listeners.get('tools/pre-execute') ?? [])
          result = await (
            fn as unknown as (e: unknown, n: () => Promise<unknown>) => Promise<{ kind: string; reason?: string }>
          )({ name, arguments: args, agent: { id: 'review-1' } }, async () => ({ kind: 'allow' }))
        return result
      }
      expect((await decide('oryh_list', { collection: 'business-rules' }))?.kind).toBe('allow')
      expect((await decide('oryh_request', { method: 'GET', path: '/timesheet-headers/h' }))?.kind).toBe('allow')
      // The same tool in a call that would write is refused before it is made.
      expect(await decide('oryh_request', { method: 'POST', path: '/timesheet-headers/h/submit' })).toMatchObject({
        kind: 'deny',
        reason: expect.stringMatching(/只能读取/),
      })
      expect((await decide('bash', { command: 'ls' }))?.kind).toBe('deny')
      // What it reads is its working: the pane the person is looking at does not follow it.
      await f.bind()
      f.page.sync('my-open-todos', { key: 'my-open-todos:list', title: '我的待办', detail: '', scope: '' })
      const leave = f.pane.standIn('review-1', 's')
      await f.tool('oryh_list').execute({ collection: 'timesheet-headers' }, { ...f.exec, agent: { id: 'review-1' } })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(f.navigation()).toBeUndefined()
      leave()
    } finally {
      await f.close()
    }
  })
  describe('files the person attached in Chat', () => {
    const digest = (head: string) => `sha256:${head}${'0'.repeat(64 - head.length)}`
    const pdf = { attachmentId: digest('1a2b3c4d'), name: '发票.pdf', bytes: 4 }
    const photo = {
      attachmentId: digest('9f8e7d6c'),
      name: 'scan.png',
      mediaType: 'image/jpeg',
      bytes: 3,
      width: 1,
      height: 1,
    }
    const conversation = [
      {
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '这两张报销' },
          { type: 'file', attachment: pdf },
          { type: 'image', attachment: photo },
        ],
      },
      // What a tool or a plugin put in the conversation is not a file the person chose.
      {
        role: 'user',
        source: { kind: 'tool' },
        content: [{ type: 'file', attachment: { attachmentId: digest('55555555'), name: 'report.pdf', bytes: 9 } }],
      },
    ]
    const exec = (messages: unknown[] = conversation) => ({
      agent: { id: 's', session: { deriveMessages: () => messages } },
      callId: 'call-1',
      signal: new AbortController().signal,
    })

    it("files what the person attached, by sha256 prefix or name, in place of ORYH's upload tool", async () => {
      const f = await setup({
        attachments: true,
        mcpTools: [
          { name: 'upload_attachment', readOnly: false },
          { name: 'oryh_request', readOnly: false },
        ],
      })
      try {
        const [policy] = await f.created()
        expect(policy!.allow).toContain('upload_attachment')
        expect(f.prompt()).toContain('用 upload_attachment 按文件名或 sha256 前缀上传')
        await f.agent.mcpTools.refresh(connectionId)
        // ORYH's own tool wants the bytes from the model; the Host's takes its name, so it is not offered.
        expect([...f.agent.mcpTools.names]).toEqual(['oryh_request'])
        await f.bind()
        const answer = JSON.parse(
          await f
            .tool('upload_attachment')
            .execute({ files: ['sha256:1a2b3c4d', 'scan.png', 'report.pdf', '合同.pdf'] }, exec()),
        )
        expect(answer).toEqual([
          { file: '发票.pdf', id: 'att-发票.pdf', sha256: 'digest', size_bytes: 4, already_existed: false },
          // A picture is filed as the Host stored it, under a name that says what it now is.
          { file: 'scan.jpg', id: 'att-scan.jpg', sha256: 'digest', size_bytes: 3, already_existed: true },
          { file: 'report.pdf', error: '本会话里没有找到用户附上的「report.pdf」。' },
          { file: '合同.pdf', error: '本会话里没有找到用户附上的「合同.pdf」。' },
        ])
        expect(f.upload).toHaveBeenCalledWith(connectionId, {
          filename: '发票.pdf',
          contentType: 'application/pdf',
          data: new Uint8Array([37, 80, 68, 70]),
        })
        expect(f.upload).toHaveBeenCalledWith(connectionId, {
          filename: 'scan.jpg',
          contentType: 'image/jpeg',
          data: new Uint8Array([255, 216, 255]),
        })
        expect(f.upload).toHaveBeenCalledTimes(2)
      } finally {
        await f.close()
      }
    })

    it('asks for the file when nothing was attached, and reads nothing too large to file', async () => {
      const f = await setup({ attachments: true })
      try {
        await f.bind()
        await expect(f.tool('upload_attachment').execute({ files: ['发票.pdf'] }, exec([]))).rejects.toThrow(
          '请对方在对话框里附上文件',
        )
        const large = { ...pdf, bytes: 11 * 1024 * 1024 }
        const answer = JSON.parse(
          await f
            .tool('upload_attachment')
            .execute(
              { files: ['发票.pdf'] },
              exec([{ ...conversation[0], content: [{ type: 'file', attachment: large }] }]),
            ),
        )
        expect(answer).toEqual([{ file: '发票.pdf', error: '发票.pdf 有 11.0 MB，超过 ORYH 附件 10 MB 的上限。' }])
        expect(f.upload).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    })

    it('names what the session uploaded when ORYH cannot find an attachment a write cites', async () => {
      const f = await setup({
        mcpTools: [{ name: 'oryh_request', readOnly: false, isError: true }],
        refusal: '{"detail":"Attachment not found"}',
      })
      try {
        await f.agent.mcpTools.refresh(connectionId)
        const filed = '14ecd5e9-2791-4563-9f23-61d48347c56b'
        const session = [
          ...conversation,
          {
            role: 'assistant',
            source: { kind: 'model' },
            content: [{ type: 'tool-call', id: 'u1', name: 'upload_attachment' }],
          },
          // A tool's result is a message of its own since DSH 0.1.7, in the tool role, naming its call.
          {
            role: 'tool',
            source: { kind: 'tool' },
            toolCallId: 'u1',
            content: [{ type: 'text', text: JSON.stringify([{ file: '电子发票.pdf', id: filed, sha256: 'd' }]) }],
          },
        ]
        // The model copied the id one character off; what it uploaded is named so it can see that.
        const cited = {
          method: 'POST',
          path: '/expense-claims',
          body: { attachment_id: filed.replace('61d4', '61c4') },
        }
        const refused = f.tool('oryh_request').execute(cited, exec(session))
        await expect(refused).rejects.toThrow(`本会话用 upload_attachment 上传过的附件：电子发票.pdf → ${filed}`)
        await expect(refused).rejects.toThrow('第 27 个字符是 c，应为 d')
        // Any other refusal, or one in a session that uploaded nothing, reads as ORYH wrote it.
        await expect(f.tool('oryh_request').execute(cited, exec())).rejects.toThrow(
          /^\{"detail":"Attachment not found"\}$/,
        )
      } finally {
        await f.close()
      }
    })

    it('is not offered where nothing can be written', async () => {
      const f = await setup({ attachments: true, capabilities: { shell: false, writes: false } })
      try {
        const [policy] = await f.created()
        expect(policy!.allow).not.toContain('upload_attachment')
        expect(f.tools.has('upload_attachment')).toBe(false)
        expect(f.prompt()).not.toContain('upload_attachment')
      } finally {
        await f.close()
      }
    })
  })
})
