import { describe, expect, it } from 'vitest'
import { PaneService } from '../src/service.js'
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
  it('rejects forked sessions and sessions this Host does not know', async () => {
    const f = await setup()
    try {
      await expect(f.pane.bind({ sessionId: 'other', connectionId })).rejects.toThrow(/已打开的会话/)
      f.agent.session.header.parentSession = 'parent'
      await expect(f.bind()).rejects.toThrow(/分支/)
    } finally {
      await f.close()
    }
  })
  it('refuses a sync before binding, and ignores a stale revision', async () => {
    const f = await setup()
    try {
      expect(() => f.page.sync('my-open-todos')).toThrow(/尚未绑定/)
      await f.bind()
      f.page.sync('list-projects', { key: 'list-projects:list', title: '项目', detail: '', scope: '' })
      f.pane.sync({ sessionId: 's', connectionId, instance: 'i', revision: 1, page: 'timesheets' })
      expect(f.pane.session('s')?.page).toBe('list-projects')
      // A new pane instance starts over, whatever revision it counts from.
      f.pane.sync({ sessionId: 's', connectionId, instance: 'j', revision: 1, page: 'timesheets' })
      expect(f.pane.session('s')?.page).toBe('timesheets')
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
      const remove = f.pane.contribute({ name: 'later', resources: { projects: 'list-projects' } })
      expect(f.pane.pageOf('projects')).toBe('list-projects')
      remove()
      expect(f.pane.pageOf('projects')).toBeUndefined()
      expect(changes).toBe(2)
      off()
    } finally {
      await f.close()
    }
  })
})

describe('the current page', () => {
  it('publishes the unsaved project form without confirmation credentials and drops it on leaving', async () => {
    const f = await setup()
    try {
      await f.bind()
      const fields = { project_name: '人工输入', project_code: '', client: '', start_date: '', end_date: '' }
      f.page.sync('list-projects', {
        key: 'list-projects:new',
        title: '项目',
        detail: '',
        scope: '',
        project: { fields, busy: false },
      })
      const page = JSON.parse(await f.tool('oryh_current_page').execute({}, f.exec))
      expect(page).toMatchObject({ page: 'list-projects', capabilities: { create: true } })
      expect(page.visible).toMatchObject({ fields, unsaved: true })
      expect(JSON.stringify(page)).not.toContain('token')
      f.page.sync('settings')
      expect(JSON.parse(await f.tool('oryh_current_page').execute({}, f.exec)).visible).toBeUndefined()
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

describe('navigation commands', () => {
  it('opens a page once the pane acknowledges, and includes the page content it then shows', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('list-projects', { key: 'list', title: '项目', detail: '筛选', scope: '当前页', content: '项目甲' })
      const opening = f.tool('oryh_navigate').execute({ page: 'my-expense-claims' }, f.exec)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({ target: 'page', page: 'my-expense-claims' })
      f.page.ack('navigation', 'my-expense-claims', {
        key: 'expenses',
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
  it('does not queue navigation after the server revokes the required grant', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos')
      f.connection.identity.permissions = []
      await expect(f.tool('oryh_navigate').execute({ page: 'inventory-items' }, f.exec)).rejects.toThrow('权限')
      expect(f.navigation()).toBeUndefined()
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
      await expect(navigate(f.pane, 's', 'list-projects', aborted.signal)).rejects.toThrow()
      expect(f.navigation()).toBeUndefined()
      const moving = navigate(f.pane, 's', 'list-projects', new AbortController().signal)
      await until(() => f.navigation() !== undefined)
      f.page.sync('timesheets')
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
      const navigating = navigate(f.pane, 's', 'list-projects', new AbortController().signal)
      const update = (await next).value as PaneFrame
      expect(update.type).toBe('update')
      const command = update.commands[0]!
      expect(command.lane).toBe('navigation')
      // A reconnect re-opens the stream: its baseline still carries the command the page never saw.
      const reopened = open(f, new AbortController().signal)
      expect((await reopened.next()).value).toEqual({ type: 'baseline', commands: [command], state: {} })
      controller.abort()
      f.page.ack('navigation', 'list-projects', { key: 'list-projects:list', title: '项目', detail: '', scope: '' })
      expect(JSON.parse(await navigating)).toMatchObject({ page: 'list-projects' })
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
      const navigating = navigate(f.pane, 's', 'list-projects', tool.signal).catch(() => undefined)
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
      const first = navigate(f.pane, 's', 'list-projects', firstTool.signal).catch(() => undefined)
      await until(() => f.navigation() !== undefined)
      const superseded = f.navigation()!.id
      // A second command on the same lane replaces the first while the consumer is still idle.
      const second = navigate(f.pane, 's', 'timesheets', secondTool.signal).catch(() => undefined)
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
