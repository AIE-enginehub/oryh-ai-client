// @vitest-environment jsdom
import type { ConnectionSummary, OryhOperationResult } from '@oryh/ai-client-core'
import type { PaneContext } from '@oryh/dsh-pane/types'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BusinessPage } from './business-page.js'
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
/** 华敏's todos in round 2 (R2-6): one still open, two already completed. */
const todos = [
  todo('t1', 'open', '审批 赵云峰 的工时'),
  todo('t2', 'completed', '审批 陈志远 的工时'),
  todo('t3', 'completed', '审批 吴建军 的工时'),
]
/** What "my todos" loads, with `total` the person's todos as ORYH counts them — `null` when it does not say. */
const loaded = (total: number | null) =>
  ({
    id: 'r1',
    operationId: 'my-open-todos',
    connectionId: 'c',
    executedAt: '2026-09-24T08:00:00Z',
    result: { data: todos, meta: { total, page: null, pageSize: null, pages: null } },
  }) as unknown as OryhOperationResult

interface ListContent {
  counts: {
    shownAfterFilters: number
    loadedBeforeFilters: number
    serverTotalBeforeFilters: number | null
    allLoaded: boolean
  } | null
  activeFilters: string[]
  visibleRows: { id: string }[]
}

/** "My todos" as the todo page opens it — on what is still to do — reporting its context as the Host reads it. */
async function openTodos(total: number | null, save?: () => Promise<{ id: string; label: string }>) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const contexts: PaneContext[] = []
  const remote = {
    execute: vi.fn(async () => loaded(total)),
    listSavedOperations: vi.fn(async () => []),
    saveResult: vi.fn(save ?? (async () => ({ id: 'saved-1', label: '周报' }))),
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
        defaultStatus: 'open',
        onContext: context => contexts.push(context),
      }),
    ),
  )
  // The read resolves after the first render; let it land.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  const context = () => contexts.at(-1)!
  return {
    node,
    contexts,
    remote,
    context,
    content: (): ListContent => JSON.parse(context().content!),
    /** The line under the list, beside the time it was read. */
    caption: () => node.querySelector('.data-caption span')?.textContent,
    footer: () => node.querySelector('.table-footer > span')?.textContent,
    async status(value: string) {
      // A field's label names its control by id.
      const label = [...node.querySelectorAll('label')].find(label => label.textContent?.startsWith('状态'))!
      const select = document.getElementById(label.htmlFor) as HTMLSelectElement
      await act(async () => {
        select.value = value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    },
    async close() {
      await act(async () => root.unmount())
      node.remove()
    },
  }
}

describe('what a filtered list tells the agent', () => {
  it('counts the rows the filter shows, and marks what was loaded and what the server has as unfiltered (R2-6)', async () => {
    const page = await openTodos(3)
    try {
      // Nothing is counted before anything is read: no "0" for the agent to repeat.
      expect(page.contexts[0]?.scope).toBe('尚未载入业务数据')
      expect(JSON.parse(page.contexts[0]!.content!).counts).toBeNull()

      // 「我还有几条待办？」 on 待处理: one is open. Three is how many there are before the filter.
      expect(page.context().detail).toBe('状态：待处理')
      expect(page.context().scope).toBe('筛选后显示 1 条（状态：待处理）。筛选前：本次载入 3 条 / 服务端共 3 条。')
      expect(page.content().counts).toEqual({
        shownAfterFilters: 1,
        loadedBeforeFilters: 3,
        serverTotalBeforeFilters: 3,
        allLoaded: true,
      })
      expect(page.content().activeFilters).toEqual(['状态：待处理'])
      expect(page.content().visibleRows.map(row => row.id)).toEqual(['t1'])
      // The person reads the same: the footer counts what is shown, the line under it what that was taken from.
      expect(page.footer()).toBe('共 1 条')
      expect(page.caption()).toBe('筛选前：本次载入 3 条 / 服务端共 3 条')

      // With the filter cleared every loaded row shows, and there is no filter to count before.
      await page.status('')
      expect(page.context().detail).toBe('当前列表 · 未添加筛选')
      expect(page.context().scope).toBe('未筛选，显示 3 条。本次载入 3 条 / 服务端共 3 条。')
      expect(page.content().counts).toEqual({
        shownAfterFilters: 3,
        loadedBeforeFilters: 3,
        serverTotalBeforeFilters: 3,
        allLoaded: true,
      })
      expect(page.content().activeFilters).toEqual([])
      expect(page.footer()).toBe('共 3 条')
      expect(page.caption()).toBe('本次载入 3 条 / 服务端共 3 条')

      await page.status('completed')
      expect(page.context().scope).toBe('筛选后显示 2 条（状态：已完成）。筛选前：本次载入 3 条 / 服务端共 3 条。')
      expect(page.content().counts?.shownAfterFilters).toBe(2)
    } finally {
      await page.close()
    }
  })

  it('keeps the rows and the agent context while a shortcut is being saved', async () => {
    let release!: () => void
    const saved = new Promise<{ id: string; label: string }>(resolve => {
      release = () => resolve({ id: 'saved-1', label: '周报' })
    })
    const page = await openTodos(3, () => saved)
    try {
      const input = page.node.querySelector('.toolbar input') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setter.call(input, '周报')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const button = input.closest('.toolbar')!.querySelector('button') as HTMLButtonElement
      await act(async () => {
        button.click()
        await Promise.resolve()
      })
      // The save is still pending: the list and what the agent reads stay as they were.
      expect(page.remote.saveResult).toHaveBeenCalledTimes(1)
      expect(page.content().loading).toBe(false)
      expect(page.content().visibleRows.map(row => row.id)).toEqual(['t1'])
      release()
      await act(async () => {
        await saved
        await Promise.resolve()
      })
    } finally {
      await page.close()
    }
  })

  it.each([
    {
      total: 250,
      server: '服务端共 250 条',
      line: '筛选前：本次载入 3 条 / 服务端共 250 条；筛选只作用于本次载入的记录',
    },
    {
      total: null,
      server: '服务端总量未知',
      line: '筛选前：本次载入 3 条（服务端总量未知）；筛选只作用于本次载入的记录',
    },
  ])('says the filter only saw what was loaded when that is not everything ($server)', async ({ total, line }) => {
    const page = await openTodos(total)
    try {
      expect(page.context().scope).toBe(`筛选后显示 1 条（状态：待处理）。${line}。`)
      expect(page.content().counts).toEqual({
        shownAfterFilters: 1,
        loadedBeforeFilters: 3,
        serverTotalBeforeFilters: total,
        allLoaded: false,
      })
      expect(page.footer()).toBe('1 条（仅本次载入）')
      expect(page.caption()).toBe(line)
    } finally {
      await page.close()
    }
  })
})
