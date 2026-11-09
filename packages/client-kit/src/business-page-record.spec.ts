// @vitest-environment jsdom
import type { ConnectionSummary, OryhOperationResult } from '@oryh/ai-client-core'
import type { PaneContext } from '@oryh/dsh-pane/types'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BusinessPage, listConditions } from './business-page.js'
import { fakeFace } from './pane-test.js'

// The list keeps its filter and page for the enterprise identity; one test's must not reach the next.
beforeEach(() => localStorage.clear())

const connection = {
  id: 'c',
  origin: 'https://oryh.test',
  identity: { tenant: { id: 't' }, user: { id: 'u', employeeId: 'e' } },
} as unknown as ConnectionSummary
const todo = (id: string, status: string, title: string) => ({
  id,
  employeeId: 'e',
  entityType: 'timesheet_header',
  entityId: `h-${id}`,
  title,
  description: null,
  todoType: null,
  status,
  dueAt: null,
  target: null,
})
const result = (data: unknown[]) =>
  ({
    id: 'r1',
    operationId: 'my-open-todos',
    connectionId: 'c',
    executedAt: '2026-09-24T08:00:00Z',
    result: { data, meta: { total: data.length, page: null, pageSize: null, pages: null } },
  }) as unknown as OryhOperationResult

/** "My todos" with two loaded, inside a pane the test drives. */
async function openTodos(one: (id: string) => Promise<OryhOperationResult>) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const contexts: PaneContext[] = []
  const remote = {
    execute: vi.fn(async () =>
      result([todo('t1', 'open', '审批 赵云峰 的工时'), todo('t2', 'open', '审批 陈志远 的工时')]),
    ),
    executeOne: vi.fn(async (_connection: string, _operation: string, id: string) => one(id)),
    listSavedOperations: vi.fn(async () => []),
  }
  const pane = fakeFace({ connection, remote })
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () =>
    root.render(
      h(BusinessPage, {
        face: pane.face,
        connection,
        operationId: 'my-open-todos',
        title: '我的待办',
        active: true,
        onContext: context => contexts.push(context),
      }),
    ),
  )
  const settle = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  await settle()
  return {
    node,
    pane,
    remote,
    settle,
    context: () => contexts.at(-1)!,
    /** The agent narrows the list, or a read it made in Chat is followed. */
    narrow: (command: string, queryValues: Record<string, string>) =>
      act(async () =>
        pane.command({
          lane: 'navigation',
          id: command,
          page: 'my-open-todos',
          payload: { target: 'filters', page: 'my-open-todos', queryValues },
        }),
      ),
    /** The agent asks for one record of this list. */
    open: (command: string, recordId: string) =>
      act(async () =>
        pane.command({
          lane: 'navigation',
          id: command,
          page: 'my-open-todos',
          payload: { target: 'record', page: 'my-open-todos', recordId },
        }),
      ),
    async close() {
      await act(async () => root.unmount())
      node.remove()
    },
  }
}

describe('a list asked to open one record by id', () => {
  it('opens a record it holds from its rows, with no further read', async () => {
    const page = await openTodos(async () => {
      throw new Error('not asked')
    })
    try {
      await page.open('n1', 't2')
      await page.settle()
      expect(page.pane.acked()).toEqual(['n1'])
      expect(page.context()).toMatchObject({ key: 'my-open-todos:t2', title: '审批 陈志远 的工时' })
      expect(page.remote.executeOne).not.toHaveBeenCalled()
    } finally {
      await page.close()
    }
  })

  it('reads a record it has not loaded by itself and shows it, the list staying what it was', async () => {
    const page = await openTodos(async id => result([todo(id, 'completed', '审批 吴建军 的工时（去年）')]))
    try {
      await page.open('n1', 't9')
      await page.settle()
      expect(page.remote.executeOne).toHaveBeenCalledWith('c', 'my-open-todos', 't9')
      expect(page.pane.acked()).toEqual(['n1'])
      expect(page.context()).toMatchObject({ key: 'my-open-todos:t9', title: '审批 吴建军 的工时（去年）' })
      expect(JSON.parse(page.context().content!).counts.loadedBeforeFilters).toBe(2)
      expect(page.remote.execute).toHaveBeenCalledTimes(1)
    } finally {
      await page.close()
    }
  })

  it('says so, once, when the record cannot be read at all', async () => {
    const page = await openTodos(async () => {
      throw new Error('这条记录不在这个列表里，或者你没有查看它的权限。')
    })
    try {
      await page.open('n1', 'gone')
      await page.settle()
      expect(page.pane.acked()).toEqual(['n1'])
      expect(page.context().key).toBe('my-open-todos:list')
      expect(page.node.textContent).toContain('没有找到要打开的这条记录')
      expect(page.remote.executeOne).toHaveBeenCalledTimes(1)
    } finally {
      await page.close()
    }
  })
})

describe('a list narrowed from Chat', () => {
  it('says what it can be narrowed by, and takes the conditions given as its conditions', async () => {
    const page = await openTodos(async () => {
      throw new Error('not asked')
    })
    try {
      expect(page.context().listFilter).toEqual({
        fields: ['text', 'status', 'from', 'to'],
        values: { text: '', status: '', from: '', to: '' },
      })
      await page.narrow('f1', { text: '赵云峰', status: 'open' })
      expect(page.pane.acked()).toEqual(['f1'])
      expect(page.context().listFilter?.values).toEqual({ text: '赵云峰', status: 'open', from: '', to: '' })
      expect(JSON.parse(page.context().content!).counts.shownAfterFilters).toBe(1)
      // The conditions given are the conditions: the keyword is not kept beside a new span of dates.
      await page.narrow('f2', { from: '2026-10-01', to: '2026-10-07' })
      expect(page.context().listFilter?.values).toEqual({ text: '', status: '', from: '2026-10-01', to: '2026-10-07' })
      await page.narrow('f3', {})
      expect(page.context().listFilter?.values).toEqual({ text: '', status: '', from: '', to: '' })
    } finally {
      await page.close()
    }
  })

  it('reads the conditions of a read made through ORYH for what this list can narrow by', () => {
    // A status is a status either way, and a search goes by several names.
    expect(listConditions({ status: 'open', employee_id: 'e-1', include: 'target' })).toEqual({ status: 'open' })
    expect(listConditions({ q: ' 工时 ' })).toEqual({ text: '工时' })
    expect(listConditions({ search: '报销', text: '差旅' })).toEqual({ text: '差旅' })
    // Several statuses at once, and a date that is not a day, are not something this list shows.
    expect(listConditions({ status: 'open,completed', from: '上周', to: '2026-10-07' })).toEqual({ to: '2026-10-07' })
    expect(listConditions({})).toEqual({})
  })
})
