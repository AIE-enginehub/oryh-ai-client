import { describe, expect, it } from 'vitest'
import { objectTypeOf, PaneService } from '../src/service.js'
import {
  connectionId,
  fakeConnection,
  fakeContext,
  fakeController,
  paneSyncer,
  pending,
  tempDirectory,
  until,
} from '../src/testing.js'
import { installPaneTools, navigate } from '../src/tools.js'
import type { NavigationCommand, PaneFrame } from '../src/types.js'
import { UserViewRegistry } from '../src/user-views.js'

/** The pane on its own: a session bound to one enterprise, the page tools, and the stream to the page. */
async function setup(connections = 1) {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const { connection, controller } = fakeController(fakeConnection(), connections)
  const create = () => new PaneService(harness.ctx, controller, temp.directory, new UserViewRegistry(harness.ctx))
  const pane = create()
  installPaneTools(harness.ctx, pane)
  pane.contribute({ name: 'todos', resources: { todos: 'my-open-todos' } })
  const exec = { agent: { id: 's' }, callId: 'call-1', signal: new AbortController().signal }
  return {
    ...harness,
    pane,
    create,
    connection,
    exec,
    page: paneSyncer(pane),
    bind: () => pane.bind({ sessionId: 's', connectionId }),
    navigation: () => pending(pane) as NavigationCommand | undefined,
    close: temp.close,
  }
}
describe('session binding', () => {
  it('pins a session to one enterprise identity across plugin restarts', async () => {
    const f = await setup()
    try {
      expect((await f.bind()).ready).toBe(true)
      f.connection.identity.tenant.id = 'other'
      await expect(f.create().bind({ sessionId: 's', connectionId })).rejects.toThrow(/其他企业/)
    } finally {
      await f.close()
    }
  })
  it('stops asking a provider that was taken off, as a plugin reloaded by itself takes its own off', async () => {
    const f = await setup()
    try {
      const entry = (id: string) => ({ id, label: id, collection: 'sales-orders', filters: {} })
      const first = f.pane.provideMenu(async () => [entry('first')] as never)
      // The plugin reloads: its old registration goes with its effect, and the new one stands alone.
      first()
      f.pane.provideMenu(async () => [entry('second')] as never)
      expect((await f.pane.connectionMenu(connectionId)).map(item => item.id)).toEqual(['second'])
      // Taking one off twice takes nothing else with it.
      first()
      expect(await f.pane.connectionMenu(connectionId)).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('binds a session that has not been spoken to yet, and refuses a fork whenever it is seen', async () => {
    const f = await setup()
    try {
      // The workbench binds as it opens; a reopened session gets its agent only when the person speaks.
      expect((await f.pane.bind({ sessionId: 'other', connectionId })).ready).toBe(true)
      expect((await f.bind()).ready).toBe(true)
      // The session turns out to be a branch: its business tools are refused, and so is binding it again.
      f.agent.session.header.parentSession = 'parent'
      expect(() => f.pane.home('s')).toThrow(/分支/)
      await expect(f.bind()).rejects.toThrow(/分支/)
      expect(f.pane.home('other')).toBeDefined()
    } finally {
      await f.close()
    }
  })
  it('lets a session the Host started read the pane of the session it works for', async () => {
    const f = await setup()
    try {
      // The parent is bound and shows a page. The child is a session of its own, with that parent in its header.
      await f.pane.bind({ sessionId: 'other', connectionId })
      f.pane.sync({ sessionId: 'other', connectionId, instance: 'i', revision: 1, page: 'shipments' })
      f.agent.session.header.parentSession = 'other'
      // Left to itself it has no pane at all.
      expect(() => f.pane.home('s')).toThrow(/请先连接企业/)
      // Standing in, it reads its parent's — and is not refused as a copy somebody made of a conversation,
      // which is what its header alone says it is. Refused, a review could not read the document it was given.
      const release = f.pane.standIn('s', 'other')
      expect(f.pane.home('s')).toBe(f.pane.home('other'))
      expect((await f.pane.verified('s')).session.page).toBe('shipments')
      release()
      expect(() => f.pane.home('s')).toThrow(/请先连接企业/)
    } finally {
      await f.close()
    }
  })
  it('refuses a sync before binding, and ignores a stale revision', async () => {
    const f = await setup()
    try {
      expect(() => f.page.sync('my-open-todos')).toThrow(/尚未绑定/)
      await f.bind()
      f.page.sync('inventory-item-details', {
        key: 'inventory-item-details:list',
        title: '项目',
        detail: '',
        scope: '',
      })
      f.pane.sync({ sessionId: 's', connectionId, instance: 'i', revision: 1, page: 'shipments' })
      expect(f.pane.session('s')?.page).toBe('inventory-item-details')
      // A new pane instance starts over, whatever revision it counts from.
      f.pane.sync({ sessionId: 's', connectionId, instance: 'j', revision: 1, page: 'shipments' })
      expect(f.pane.session('s')?.page).toBe('shipments')
    } finally {
      await f.close()
    }
  })
  it('maps a resource to the page that contributed it', async () => {
    const f = await setup()
    try {
      expect(f.pane.pageOf('todos')).toBe('my-open-todos')
      expect(f.pane.pageOf('nothing')).toBeUndefined()
      let changes = 0
      const off = f.pane.onContributionsChange(() => {
        changes++
      })
      const remove = f.pane.contribute({
        name: 'later',
        resources: { 'inventory-item-details': 'inventory-item-details' },
      })
      expect(f.pane.pageOf('inventory-item-details')).toBe('inventory-item-details')
      remove()
      expect(f.pane.pageOf('inventory-item-details')).toBeUndefined()
      expect(changes).toBe(2)
      off()
    } finally {
      await f.close()
    }
  })
})

describe('the current page', () => {
  it('publishes an unsaved form as a form the page describes, and drops it on leaving', async () => {
    const f = await setup()
    try {
      await f.bind()
      const values = { project_name: '人工输入', project_code: '', client: '', start_date: '', end_date: '' }
      const form = {
        id: 'project',
        label: '新建项目',
        fields: [{ name: 'project_name', label: '项目名称', type: 'text' as const, required: true, maxLength: 200 }],
        values,
        busy: false,
      }
      f.page.sync('analytics', {
        key: 'analytics:page-1',
        title: '项目登记',
        detail: '',
        scope: '',
        unsaved: true,
        forms: [form],
      })
      const page = JSON.parse(await f.tool('oryh_current_page').execute({}, f.exec))
      expect(page).toMatchObject({ page: 'analytics' })
      // No page has a section of its own for its form: it is read, and filled, like any form a page describes.
      expect(page.visible).toBeUndefined()
      expect(page.context).toMatchObject({ unsaved: true, forms: [form] })
      expect(page.capabilities.notice).toContain('业务写入按对应的 skill 在对话里完成')
      expect(JSON.stringify(page)).not.toContain('token')
      f.page.sync('settings')
      expect(JSON.parse(await f.tool('oryh_current_page').execute({}, f.exec)).context).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('answers that no page is open instead of failing, so the agent carries on through skills', async () => {
    const f = await setup()
    try {
      const page = JSON.parse(await f.tool('oryh_current_page').execute({}, f.exec))
      expect(page.page).toBeNull()
      expect(page.notice).toMatch(/skill/)
      // Signed in, but with the business pane closed: navigating is the one thing worth trying there,
      // so it reports what it found instead of refusing.
      await f.bind()
      const navigated = JSON.parse(await f.tool('oryh_navigate').execute({ page: 'my-open-todos' }, f.exec))
      expect(navigated).toMatchObject({ opened: false })
      expect(navigated.notice).toMatch(/ORYH 业务/)
    } finally {
      await f.close()
    }
  })
})

describe('the record links the pane shows', () => {
  it('publishes each collection a page opens by id or shows in its own way, under both of its names', async () => {
    const f = await setup()
    try {
      await f.bind()
      expect(f.pane.frame('s').state.recordLinks).toBeUndefined()
      f.pane.contribute({ name: 'records', resources: { 'sales-orders': 'list-sales-orders' }, opensRecords: true })
      f.pane.contribute({
        name: 'shipments',
        resources: { 'timesheet-headers': 'shipments' },
        show: async () => {},
      })
      // A page that lists a collection but opens no record of it by id is not among them.
      f.pane.contribute({ name: 'plain', resources: { invoices: 'analytics' } })
      expect(f.pane.frame('s').state.recordLinks).toEqual([
        'sales-orders',
        'sales_order',
        'timesheet-headers',
        'timesheet_header',
      ])
    } finally {
      await f.close()
    }
  })
})

describe('what a page starts in the session', () => {
  it('puts a question asked from a page to the agent as the person’s turn, and says where it was asked', async () => {
    const f = await setup()
    try {
      const said: string[] = []
      f.agent.followup = (message: { id: string; content?: { text?: string }[] }) => {
        said.push(String(message.content?.[0]?.text))
      }
      await f.bind()
      f.page.sync('sales-orders', { key: 'sales-orders:so-7', title: 'SO202606002', detail: '', scope: '' })
      await f.pane.ask('s', '  请说明这条记录现在的情况。 ')
      expect(said).toEqual(['请说明这条记录现在的情况。\n\n（在页面“SO202606002”上提问）'])
      await expect(f.pane.ask('s', '   ')).rejects.toThrow(/无效/)
      await expect(f.pane.ask('s', 'x'.repeat(501))).rejects.toThrow(/无效/)
      await expect(f.pane.ask('nobody', '在吗')).rejects.toThrow(/会话/)
    } finally {
      await f.close()
    }
  })
  it('says which row of a list a question is about, by its name and by where to read it', async () => {
    const f = await setup()
    try {
      const said: string[] = []
      f.agent.followup = (message: { content?: { text?: string }[] }) => {
        said.push(String(message.content?.[0]?.text))
      }
      await f.bind()
      f.page.sync('sales-orders', { key: 'sales-orders:list', title: '销售订单', detail: '', scope: '' })
      const id = '2df5ffdc-2924-4978-8ab1-ac335733d941'
      await f.pane.ask('s', '为什么还没发货？', { title: 'SO202606002', resource: 'sales-orders', id })
      await f.pane.ask('s', '这条是什么情况？', { title: '草稿 3' })
      expect(said).toEqual([
        `为什么还没发货？\n\n（在页面“销售订单”上提问；关于“SO202606002”，集合 sales-orders，记录编号 ${id}）`,
        '这条是什么情况？\n\n（在页面“销售订单”上提问；关于“草稿 3”）',
      ])
      // Nothing a page would not have sent reaches the conversation as the person's words.
      for (const subject of [
        { title: '' },
        { title: 'x'.repeat(201) },
        { title: 'SO1', resource: 'sales-orders' },
        { title: 'SO1', resource: 'Sales Orders', id },
        { title: 'SO1', resource: 'sales-orders', id: '../etc' },
      ])
        await expect(f.pane.ask('s', '在吗', subject)).rejects.toThrow(/无效/)
      expect(said).toHaveLength(2)
    } finally {
      await f.close()
    }
  })
  it('brings back the agent of a session nobody has spoken in since it was reopened', async () => {
    const f = await setup()
    try {
      // Bound as the workbench opens; no agent until the person speaks — or Harness's lookup is asked.
      await f.pane.bind({ sessionId: 'reopened', connectionId })
      await expect(f.pane.agentOf('reopened')).rejects.toThrow(/会话不可用/)
      const said: string[] = []
      const resumed = {
        id: 'reopened',
        followup: (m: { content?: { text?: string }[] }) => said.push(String(m.content?.[0]?.text)),
      }
      Object.assign(f.ctx, {
        typert: {
          lookups: { get: (kind: string) => (kind === 'agent' ? { resolve: async () => resumed } : undefined) },
        },
      })
      expect(await f.pane.agentOf('reopened')).toBe(resumed)
      // No page reported for it: the question goes as it is, after the short wait for one.
      await f.pane.ask('reopened', '我有哪些待办？')
      expect(said).toEqual(['我有哪些待办？'])
      // The live one is used as it is.
      expect(await f.pane.agentOf('s')).toBe(f.agent)
    } finally {
      await f.close()
    }
  }, 10_000)
  it('waits for a just-started session to report its page, and not for one that is not bound', async () => {
    const f = await setup()
    try {
      const started = Date.now()
      await f.pane.whenPage('unbound')
      expect(Date.now() - started).toBeLessThan(40)
      await f.bind()
      setTimeout(() => f.page.sync('my-open-todos'), 80)
      await f.pane.whenPage('s')
      expect(f.pane.session('s')?.page).toBe('my-open-todos')
    } finally {
      await f.close()
    }
  })
})

describe('navigation commands', () => {
  it('opens a page once the pane acknowledges, and includes the page content it then shows', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('inventory-item-details', {
        key: 'inventory-item-details:list',
        title: '项目',
        detail: '筛选',
        scope: '当前页',
        content: '项目甲',
      })
      const opening = f.tool('oryh_navigate').execute({ page: 'analytics' }, f.exec)
      await until(() => f.navigation() !== undefined)
      // Opened to answer, not asked for: on a narrow screen it opens behind Chat.
      expect(f.navigation()?.payload).toEqual({ target: 'page', page: 'analytics' })
      f.page.ack('navigation', 'analytics', {
        key: 'analytics:list',
        title: '费用',
        detail: '',
        scope: '',
        content: '费用乙',
      })
      expect(JSON.parse(await opening).context.content).toBe('费用乙')
    } finally {
      await f.close()
    }
  })
  it('still tells the pane to open the page already showing, so a narrow screen shows it again', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos', { key: 'my-open-todos:list', title: '我的待办', detail: '', scope: '' })
      const opening = f.tool('oryh_navigate').execute({ page: 'my-open-todos', show: true }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toEqual({ target: 'page', page: 'my-open-todos', reveal: true })
      f.page.ack('navigation', 'my-open-todos', { key: 'my-open-todos:list', title: '我的待办', detail: '', scope: '' })
      expect(JSON.parse(await opening).page).toBe('my-open-todos')
    } finally {
      await f.close()
    }
  })
  it('keeps a page opening alive while the pane is still reporting the page it was asked from', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('inventory-item-details', {
        key: 'inventory-item-details:list',
        title: '项目',
        detail: '',
        scope: '',
      })
      const opening = f.tool('oryh_navigate').execute({ page: 'analytics' }, f.exec)
      await until(() => f.navigation() !== undefined)
      // The page the person is on goes on reporting itself — a list finishes loading, say — while the
      // pane has not moved yet. That is not the person navigating away from the command.
      f.page.sync('inventory-item-details', {
        key: 'inventory-item-details:list',
        title: '项目',
        detail: '第 2 页',
        scope: '',
      })
      f.page.sync('inventory-item-details', {
        key: 'inventory-item-details:list',
        title: '项目',
        detail: '第 3 页',
        scope: '',
      })
      expect(f.navigation()).toBeDefined()
      f.page.ack('navigation', 'analytics', {
        key: 'analytics:list',
        title: '费用',
        detail: '',
        scope: '',
      })
      expect(JSON.parse(await opening).page).toBe('analytics')
    } finally {
      await f.close()
    }
  })
  it('does not open a page this client no longer has, whatever the grants', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos')
      // The tool does not name it, and a caller that does is refused before anything is queued.
      await expect(f.tool('oryh_navigate').execute({ page: 'inventory-items' }, f.exec)).rejects.toThrow(
        'must be one of',
      )
      await expect(navigate(f.pane, 's', 'inventory-items', new AbortController().signal)).rejects.toThrow(
        '没有这个页面',
      )
      expect(f.navigation()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('leaves a page the person is typing in where it is, unless they ask to see another', async () => {
    const f = await setup()
    try {
      await f.bind()
      const form = { key: 'expense:new-1', title: '费用申请表', detail: '未保存', scope: '', unsaved: true }
      f.page.sync('sales-orders', form)
      // Opened to answer a question: the form stays, and the agent is told so as an answer, not a failure.
      const kept = JSON.parse(await f.tool('oryh_navigate').execute({ page: 'analytics' }, f.exec))
      expect(kept.opened).toBe(false)
      expect(kept.notice).toMatch(/尚未保存/)
      expect(f.navigation()).toBeUndefined()
      // Following what the agent read is a courtesy, and is not extended either.
      await f.pane.showPage('s', 'my-open-todos')
      expect(f.navigation()).toBeUndefined()
      // Any other tool that would move the pane is refused the same way.
      await expect(
        f.pane.issue(
          's',
          { lane: 'navigation', page: 'shipments', payload: { target: 'page' }, timeoutMs: 50 },
          () => ({
            until: () => 'opened',
            expired: 'late',
            signal: new AbortController().signal,
          }),
        ),
      ).rejects.toThrow(/尚未保存/)
      // The page's own commands are its own to judge, and so is anything the person asked to see.
      expect(f.pane.wouldDisplace('s', { lane: 'navigation', page: 'sales-orders', payload: { target: 'page' } })).toBe(
        false,
      )
      const opening = f.tool('oryh_navigate').execute({ page: 'analytics', show: true }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toEqual({ target: 'page', page: 'analytics', reveal: true })
      f.page.ack('navigation', 'analytics', { key: 'analytics:list', title: '自定义页面', detail: '', scope: '' })
      expect(JSON.parse(await opening).page).toBe('analytics')
      // Nothing unsaved on the page now showing: following works as before.
      await f.pane.showPage('s', 'my-open-todos')
      expect(f.navigation()?.payload).toEqual({ target: 'page', page: 'my-open-todos' })
    } finally {
      await f.close()
    }
  })
  it('leaves a record the person has open where it is, unless they ask to see something else', async () => {
    const f = await setup()
    try {
      f.pane.contribute({ name: 'records', resources: { 'sales-orders': 'sales-orders' }, opensRecords: true })
      await f.bind()
      // An order is open. Answering something else, the agent would show the todo list beside its answer.
      f.page.sync('sales-orders', { key: 'sales-orders:so-7', title: 'SO-7', detail: '', scope: '' })
      const page = JSON.parse(await f.tool('oryh_navigate').execute({ page: 'my-open-todos' }, f.exec))
      expect(page).toMatchObject({ opened: false, notice: expect.stringMatching(/正开着/) })
      expect(f.navigation()).toBeUndefined()
      // Another record of the same list is the same interruption; the one already open is none.
      const other = await f.tool('oryh_open_record').execute({ resource: 'sales-orders', id: 'so-8' }, f.exec)
      expect(JSON.parse(other)).toMatchObject({ opened: false, notice: expect.stringMatching(/正开着/) })
      expect(f.navigation()).toBeUndefined()
      // Asked to see it, the page opens.
      const asked = f.tool('oryh_navigate').execute({ page: 'my-open-todos', show: true }, f.exec)
      await until(() => f.navigation() !== undefined)
      f.page.ack('navigation', 'my-open-todos', { key: 'my-open-todos:list', title: '我的待办', detail: '', scope: '' })
      expect(JSON.parse(await asked).page).toBe('my-open-todos')
      // And a person browsing a list is followed as before.
      const browsing = f.tool('oryh_navigate').execute({ page: 'analytics' }, f.exec)
      await until(() => f.navigation() !== undefined)
      f.page.ack('navigation', 'analytics', { key: 'analytics:list', title: '自定义页面', detail: '', scope: '' })
      expect(JSON.parse(await browsing).page).toBe('analytics')
    } finally {
      await f.close()
    }
  })
  it('opens one record by id on the page that shows it, and says so when the page could not', async () => {
    const f = await setup()
    try {
      f.pane.contribute({ name: 'records', resources: { 'sales-orders': 'sales-orders' }, opensRecords: true })
      await f.bind()
      f.page.sync('my-open-todos')
      const args = { resource: 'sales-orders', id: 'so-7', show: true }
      const opening = f.tool('oryh_open_record').execute(args, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toEqual({
        target: 'record',
        page: 'sales-orders',
        recordId: 'so-7',
        reveal: true,
      })
      f.page.ack('navigation', 'sales-orders', { key: 'sales-orders:so-7', title: 'SO-7', detail: '', scope: '' })
      const opened = JSON.parse(await opening)
      expect(opened).toMatchObject({ opened: true, page: 'sales-orders', context: { key: 'sales-orders:so-7' } })
      // The page answered, but with something else on screen and a reason: the agent is told the reason.
      const failing = f.tool('oryh_open_record').execute({ resource: 'sales-orders', id: 'gone', show: true }, f.exec)
      await until(() => f.navigation() !== undefined)
      f.page.ack('navigation', 'sales-orders', {
        key: 'sales-orders:list',
        title: '销售订单',
        detail: '',
        scope: '',
        content: JSON.stringify({ error: 'Not found' }),
      })
      expect(JSON.parse(await failing)).toEqual({ opened: false, notice: '页面没有打开这条记录：Not found' })
      // A collection no page opens records of, and an id that could not be one.
      await expect(f.tool('oryh_open_record').execute({ resource: 'todos', id: 't-1' }, f.exec)).rejects.toThrow(
        /sales-orders/,
      )
      await expect(
        f.tool('oryh_open_record').execute({ resource: 'sales-orders', id: '../x' }, f.exec),
      ).rejects.toThrow(/编号无效/)
    } finally {
      await f.close()
    }
  })
  it('narrows a list that filters what it has loaded, and says where that cannot be done', async () => {
    const f = await setup()
    try {
      await f.bind()
      const list = (values: Record<string, string>) => ({
        key: 'my-open-todos:list',
        title: '我的待办',
        detail: '',
        scope: '',
        listFilter: { fields: ['text', 'status', 'from', 'to'], values },
      })
      f.page.sync('my-open-todos', list({ text: '旧词', status: '', from: '', to: '' }))
      const narrowing = f.tool('oryh_list_filter').execute({ status: 'open', from: '2026-10-01' }, f.exec)
      await until(() => f.navigation() !== undefined)
      // What is not given is cleared: the page is sent only what is to hold.
      expect(f.navigation()?.payload).toEqual({
        target: 'filters',
        page: 'my-open-todos',
        queryValues: { status: 'open', from: '2026-10-01' },
      })
      f.page.ack('navigation', 'my-open-todos', list({ text: '', status: 'open', from: '2026-10-01', to: '' }))
      expect(JSON.parse(await narrowing)).toMatchObject({
        page: 'my-open-todos',
        context: { listFilter: { values: { status: 'open', from: '2026-10-01' } } },
      })
      // Asked the moment the page opened, before it has said what it can be narrowed by: it is given that
      // moment, where it used to be refused as a list that could not be filtered.
      f.page.sync('my-open-todos', { key: 'my-open-todos:list', title: '我的待办', detail: '', scope: '' })
      const early = f.tool('oryh_list_filter').execute({ status: 'completed' }, f.exec)
      setTimeout(() => f.page.sync('my-open-todos', list({ text: '', status: 'open', from: '', to: '' })), 150)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({ target: 'filters', queryValues: { status: 'completed' } })
      f.page.ack('navigation', 'my-open-todos', list({ text: '', status: 'completed', from: '', to: '' }))
      expect(JSON.parse(await early).context.listFilter.values.status).toBe('completed')
      await expect(f.tool('oryh_list_filter').execute({ from: '10月1日' }, f.exec)).rejects.toThrow(/YYYY-MM-DD/)
      await expect(
        f.tool('oryh_list_filter').execute({ from: '2026-10-08', to: '2026-10-01' }, f.exec),
      ).rejects.toThrow(/不能晚于/)
      // A record open on that page, and a page whose list is queried through ORYH instead.
      f.page.sync('my-open-todos', { ...list({ text: '', status: '', from: '', to: '' }), key: 'my-open-todos:t1' })
      await expect(f.tool('oryh_list_filter').execute({ status: 'open' }, f.exec)).rejects.toThrow(
        /不是可以这样筛选的列表/,
      )
      f.page.sync('sales-orders', { key: 'sales-orders:list', title: '销售订单', detail: '', scope: '' })
      await expect(f.tool('oryh_list_filter').execute({ status: 'open' }, f.exec)).rejects.toThrow(/oryh_record_query/)
    } finally {
      await f.close()
    }
  })
  it('opens a record of a collection with no page of its own through the menu entry that lists it', async () => {
    const f = await setup()
    try {
      f.pane.contribute({ name: 'records', resources: { 'sales-orders': 'sales-orders' }, opensRecords: true })
      await f.bind()
      f.page.sync('my-open-todos')
      // No page, no entry: nothing here can show an invoice, and the agent is told what can be opened.
      await expect(f.tool('oryh_open_record').execute({ resource: 'invoices', id: 'inv-1' }, f.exec)).rejects.toThrow(
        /菜单里也没有它的列表.*sales-orders/,
      )
      // The person has two entries over invoices: the one that shows them all is where a record opens.
      const narrowed = { id: 'v1', label: '未付发票', collection: 'invoices', filters: { status: 'unpaid' } }
      const whole = { id: 'v2', label: '发票', collection: 'invoices', filters: {} }
      f.pane.setMenu('s', [narrowed, whole])
      expect(f.pane.frame('s').state.recordLinks).toEqual(['invoice', 'invoices', 'sales-orders', 'sales_order'])
      const opening = f.tool('oryh_open_record').execute({ resource: 'invoices', id: 'inv-1' }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toEqual({
        target: 'record',
        page: 'collection',
        userViewId: 'v2',
        recordId: 'inv-1',
      })
      f.page.ack('navigation', 'collection', { key: 'collection:inv-1', title: 'INV-1', detail: '', scope: '' })
      expect(JSON.parse(await opening)).toMatchObject({ opened: true, page: 'collection' })
      // A link in a Chat answer names it as the console does, and goes the same way.
      const shown = f.pane.showRecord('s', 'invoice', 'inv-2', new AbortController().signal)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({ userViewId: 'v2', recordId: 'inv-2', reveal: true })
      f.page.ack('navigation', 'collection', { key: 'collection:inv-2', title: 'INV-2', detail: '', scope: '' })
      expect(await shown).toEqual({ opened: true })
    } finally {
      await f.close()
    }
  })
  it('shows the record a link in a Chat answer names, by the console’s type or the collection', async () => {
    const f = await setup()
    try {
      // Every collection a page of this client shows is named by the console as this rule says.
      expect(
        [
          'sales-orders',
          'shipments',
          'inventory-items',
          'inventory-item-details',
          'todos',
          'expense-claims',
          'projects',
          'timesheet-headers',
        ].map(objectTypeOf),
      ).toEqual([
        'sales_order',
        'shipment',
        'inventory_item',
        'inventory_item_detail',
        'todo',
        'expense_claim',
        'project',
        'timesheet_header',
      ])
      const shown: string[] = []
      f.pane.contribute({ name: 'records', resources: { 'sales-orders': 'sales-orders' }, opensRecords: true })
      f.pane.contribute({
        name: 'shipments',
        resources: { 'timesheet-headers': 'shipments' },
        show: async (_session, resource, id) => {
          if (id === 'busy') throw new Error('当前有未保存修改，请保存或放弃后重新要求打开工时。')
          shown.push(`${resource}/${id}`)
        },
      })
      await f.bind()
      f.page.sync('my-open-todos')
      const signal = new AbortController().signal
      // Clicked: the person asked to see it, so it comes forward.
      const opening = f.pane.showRecord('s', 'sales_order', 'so-7', signal)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toEqual({
        target: 'record',
        page: 'sales-orders',
        recordId: 'so-7',
        reveal: true,
      })
      f.page.ack('navigation', 'sales-orders', { key: 'sales-orders:so-7', title: 'SO-7', detail: '', scope: '' })
      expect(await opening).toEqual({ opened: true })
      // A plugin that opens its records its own way is asked to; what it refuses is said in its words.
      expect(await f.pane.showRecord('s', 'timesheet_header', 'th-1', signal)).toEqual({ opened: true })
      expect(shown).toEqual(['timesheet-headers/th-1'])
      expect(await f.pane.showRecord('s', 'timesheet-headers', 'busy', signal)).toMatchObject({
        opened: false,
        notice: expect.stringContaining('未保存'),
      })
      // A record no page here shows is not a failure: the page lets the link go to the console.
      expect(await f.pane.showRecord('s', 'purchase_order', 'po-1', signal)).toMatchObject({ opened: false })
      expect(await f.pane.showRecord('s', 'todo', 't-1', signal)).toMatchObject({ opened: false })
    } finally {
      await f.close()
    }
  })
  it('cancels pending navigation on abort, and withdraws it when the page moves elsewhere', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos')
      const aborted = new AbortController()
      aborted.abort()
      await expect(navigate(f.pane, 's', 'analytics', aborted.signal)).rejects.toThrow()
      expect(f.navigation()).toBeUndefined()
      const moving = navigate(f.pane, 's', 'analytics', new AbortController().signal)
      await until(() => f.navigation() !== undefined)
      f.page.sync('shipments')
      await expect(moving).rejects.toThrow(/页面/)
      expect(f.navigation()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
})

describe('the pane stream', () => {
  const open = (f: Awaited<ReturnType<typeof setup>>, signal: AbortSignal, id = connectionId) =>
    f.pane.commands({ sessionId: 's', connectionId: id }, signal)[Symbol.asyncIterator]()
  it('opens with a baseline, republishes the whole set on change, and re-baselines a reconnect', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos')
      const controller = new AbortController()
      const frames = open(f, controller.signal)
      expect(await frames.next()).toEqual({ value: { type: 'baseline', commands: [], state: {} }, done: false })
      const next = frames.next()
      const navigating = navigate(f.pane, 's', 'analytics', new AbortController().signal)
      const update = (await next).value as PaneFrame
      expect(update.type).toBe('update')
      const command = update.commands[0]!
      expect(command.lane).toBe('navigation')
      // A reconnect re-opens the stream: its baseline still carries the command the page never saw.
      const reopened = open(f, new AbortController().signal)
      expect((await reopened.next()).value).toEqual({ type: 'baseline', commands: [command], state: {} })
      controller.abort()
      f.page.ack('navigation', 'analytics', { key: 'analytics:list', title: '自定义页面', detail: '', scope: '' })
      expect(JSON.parse(await navigating)).toMatchObject({ page: 'analytics' })
      expect(f.navigation()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('delivers a command issued between frames, without waiting for a further change', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos')
      const controller = new AbortController()
      const frames = open(f, controller.signal)
      expect(((await frames.next()).value as PaneFrame).type).toBe('baseline')
      // Nothing is awaiting the stream here: next() is called only once the Host already holds it.
      const tool = new AbortController()
      const navigating = navigate(f.pane, 's', 'analytics', tool.signal).catch(() => undefined)
      await until(() => f.navigation() !== undefined)
      const update = (await frames.next()).value as PaneFrame
      expect(update.type).toBe('update')
      expect(update.commands).toHaveLength(1)
      controller.abort()
      tool.abort()
      await navigating
    } finally {
      await f.close()
    }
  })
  it('coalesces changes across a slow consumer into the current whole set', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos')
      const controller = new AbortController()
      const frames = open(f, controller.signal)
      await frames.next()
      const firstTool = new AbortController(),
        secondTool = new AbortController()
      const first = navigate(f.pane, 's', 'analytics', firstTool.signal).catch(() => undefined)
      await until(() => f.navigation() !== undefined)
      const superseded = f.navigation()!.id
      // A second command on the same lane replaces the first while the consumer is still idle.
      const second = navigate(f.pane, 's', 'collection', secondTool.signal).catch(() => undefined)
      await until(() => f.navigation()!.id !== superseded)
      const update = (await frames.next()).value as PaneFrame
      expect(update.commands).toEqual(f.pane.frame('s').commands)
      expect(update.commands[0]!.id).not.toBe(superseded)
      controller.abort()
      firstTool.abort()
      secondTool.abort()
      await Promise.all([first, second])
    } finally {
      await f.close()
    }
  })
  it('ends the subscription when cancelled while waiting and while a frame is in flight', async () => {
    const f = await setup()
    try {
      await f.bind()
      const waiting = new AbortController()
      const idle = open(f, waiting.signal)
      await idle.next()
      const next = idle.next()
      waiting.abort()
      expect((await next).done).toBe(true)
      const processing = new AbortController()
      const busy = open(f, processing.signal)
      await busy.next()
      processing.abort()
      expect((await busy.next()).done).toBe(true)
    } finally {
      await f.close()
    }
  })
  it('refuses a stream for an enterprise this Host does not hold', async () => {
    const f = await setup()
    try {
      const stream = f.pane.commands(
        { sessionId: 's', connectionId: 'other' as typeof connectionId },
        new AbortController().signal,
      )
      await expect(
        (async () => {
          for await (const frame of stream) return frame
        })(),
      ).rejects.toThrow(/尚未绑定/)
    } finally {
      await f.close()
    }
  })
  it('binds the session again when the stream opens after a Host restart, so the pane is not deaf until a reload', async () => {
    const f = await setup()
    try {
      // The browser is still on the page; this Host has never seen the session.
      await expect(f.tool('oryh_navigate').execute({ page: 'my-open-todos' }, f.exec)).rejects.toThrow(/连接企业/)
      const stream = open(f, new AbortController().signal)
      expect((await stream.next()).value).toMatchObject({ type: 'baseline' })
      // Bound by the stream itself: page tools work now, with no reload and no second call from the page.
      const navigating = f.tool('oryh_navigate').execute({ page: 'my-open-todos' }, f.exec)
      await until(() => f.navigation()?.payload.page === 'my-open-todos')
      void navigating.catch(() => undefined)
      await stream.return?.()
    } finally {
      await f.close()
    }
  })
})
