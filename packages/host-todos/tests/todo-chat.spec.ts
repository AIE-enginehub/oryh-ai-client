import type { TodoDetailService, TodoDocument } from '@oryh/ai-client-todos'
import { PaneService, UserViewRegistry } from '@oryh/dsh-pane'
import {
  connectionId,
  fakeContext,
  fakeController,
  paneSyncer,
  pending,
  tempDirectory,
  until,
} from '@oryh/dsh-pane/testing'
import type { NavigationCommand } from '@oryh/dsh-pane/types'
import { describe, expect, it } from 'vitest'
import { TodoChat } from '../src/todo-chat.js'

const document = (title = '业务待办'): TodoDocument => ({
  todoId: 'todo',
  title,
  entityType: 'sales_quotation',
  entityId: 'q',
  fetchedAt: 'now',
  sections: [],
})

async function setup() {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const pane = new PaneService(
    harness.ctx,
    fakeController().controller,
    temp.directory,
    new UserViewRegistry(harness.ctx),
  )
  let read = async (): Promise<TodoDocument> => document()
  const details = { read: () => read() } as unknown as TodoDetailService
  const todos = new TodoChat(harness.ctx, pane, details)
  todos.install()
  return {
    ...harness,
    pane,
    todos,
    page: paneSyncer(pane),
    bind: () => pane.bind({ sessionId: 's', connectionId }),
    navigation: () => pending(pane) as NavigationCommand | undefined,
    setRead: (fn: typeof read) => {
      read = fn
    },
    close: temp.close,
  }
}

const visibleTodos = [
  { id: 'second-on-server', title: '当前第一条' },
  { id: 'first-on-server', title: '当前第二条' },
]
const list = (listRevision: string, todoId?: string) => ({
  key: `my-open-todos:${todoId ?? 'list'}`,
  title: '我的待办',
  detail: '',
  scope: '',
  todos: { visibleTodos, listRevision, ...(todoId ? { todoId } : {}) },
})

describe('visible todo navigation', () => {
  it('uses the visible order and waits for the exact authorized detail to open', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos', list('v1'))
      expect((await f.todos.visibleTodos('s')).items[0]).toEqual({ ...visibleTodos[0], position: 1 })
      const opening = f.todos.openTodo('s', 1, 'v1', new AbortController().signal)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({ target: 'todo', todoId: 'second-on-server' })
      // Acknowledged with the wrong todo open: not settled.
      f.page.ack('navigation', 'my-open-todos', list('v1', 'first-on-server'))
      await new Promise(r => setTimeout(r, 0))
      expect(f.navigation()).toBeDefined()
      f.page.sync('my-open-todos', list('v1', 'second-on-server'))
      expect((await opening).entityId).toBe('q')
    } finally {
      await f.close()
    }
  })
  it('rejects old versions, invalid positions and lists no longer visible', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos', list('v2'))
      await expect(f.todos.openTodo('s', 1, 'v1', new AbortController().signal)).rejects.toThrow(/列表已改变/)
      for (const index of [0, 3, 1.5])
        await expect(f.todos.openTodo('s', index, 'v2', new AbortController().signal)).rejects.toThrow(/序号/)
      f.page.sync('list-projects')
      await expect(f.todos.visibleTodos('s')).rejects.toThrow(/没有已同步/)
    } finally {
      await f.close()
    }
  })
  it('rejects inaccessible targets before issuing a navigation command', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos', list('v1'))
      f.setRead(async () => {
        throw Error('不属于当前员工')
      })
      await expect(f.todos.openTodo('s', 1, 'v1', new AbortController().signal)).rejects.toThrow(/不属于/)
      expect(f.navigation()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('reads the linked document of the open todo, and nothing when none is open', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos', list('v1'))
      await expect(f.todos.read('s')).rejects.toThrow(/尚未同步当前待办/)
      f.page.sync('my-open-todos', list('v1', 'second-on-server'))
      expect((await f.todos.read('s')).entityId).toBe('q')
      expect(
        JSON.parse(
          await f
            .tool('oryh_current_todo_details')
            .execute({}, { agent: { id: 's' }, signal: new AbortController().signal }),
        ).entityId,
      ).toBe('q')
    } finally {
      await f.close()
    }
  })
  it('discards an in-flight todo read when the page changes under it', async () => {
    const f = await setup()
    try {
      await f.bind()
      f.page.sync('my-open-todos', list('v', 'todo'))
      let release!: () => void
      f.setRead(async () => {
        await new Promise<void>(r => {
          release = r
        })
        return document('old')
      })
      const result = f.todos.read('s')
      await new Promise(r => setTimeout(r, 0))
      f.page.sync('list-projects')
      release()
      await expect(result).rejects.toThrow(/页面已改变/)
    } finally {
      await f.close()
    }
  })
})
