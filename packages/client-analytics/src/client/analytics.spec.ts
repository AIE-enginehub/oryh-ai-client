// @vitest-environment jsdom

import { fakeFace, sourceHook, wordsOf } from '@oryh/ai-client-kit/testing'
import { type AnalysisApi, defaultDefinition } from '@oryh/dsh-analytics/model'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AnalysisPage, AnalysisSessions, createSelections } from './index.js'
import { words } from './words.js'

const connection = {
  id: 'c',
  origin: 'https://example.invalid',
  identity: { tenant: { id: 't' }, user: { id: 'u', employeeId: 'e' }, permissions: ['inventory.manage'] },
}
/** What the page's slot hands it: a face, and the open analyses as the renderer binds them for the page. */
function slotProps() {
  const { face } = fakeFace({ connection })
  const selections = createSelections()
  type Selection = ReturnType<ReturnType<typeof selections.source>['getSnapshot']>
  function useSelection(scope: string): Selection | undefined
  function useSelection<S>(scope: string, selector: (value: Selection | undefined) => S): S
  function useSelection(scope: string, selector: (value: Selection | undefined) => unknown = value => value) {
    return sourceHook(selections.source(scope))(selector)
  }
  return {
    face,
    t: wordsOf(words),
    connection: face.connection,
    frame: face.frame,
    useSelection,
    openAnalysis: selections.open,
    setDirty: selections.setDirty,
  }
}

it('opens a saved chart, publishes actual grouped data and drill selection, and surfaces load errors without stale totals', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div'),
    root = createRoot(node),
    contexts: string[] = []
  const definition = defaultDefinition(),
    savedDocument = {
      id: '00000000-0000-4000-8000-000000000001',
      version: 1,
      updatedAt: '2026-09-19T00:00:00Z',
      definition,
    }
  const result = {
    groups: [{ key: 'warehouse', value: '2', count: 2, rowIds: ['a', 'b'] }],
    rows: ['a', 'b'].map(id => ({ id, title: id, status: '', date: '', summary: '', fields: [] })),
    total: 2,
    startedAt: '',
    fetchedAt: '2026-09-19T00:00:00Z',
    sourceTitle: '库存余额',
    groupLabel: '仓库',
    measureLabel: '记录数',
    notice: '完整结果',
  }
  const api = {
    list: vi.fn(async () => [savedDocument]),
    load: vi.fn(async () => ({ document: savedDocument, result })),
    preview: vi.fn(),
    save: vi.fn(),
  } as AnalysisApi
  const props = {
    ...slotProps(),
    sessionId: 'analytics-ui-test',
    active: true,
    onDirtyChange: vi.fn(),
    onContext: (value: { content?: string }) => {
      contexts.push(value.content ?? '')
    },
    api,
  }
  const click = async (text: string) => {
    const button = [...node.querySelectorAll('button')].find(b => b.textContent?.includes(text))
    expect(button).toBeTruthy()
    await act(async () => button!.click())
  }
  try {
    await act(async () => root.render(h(AnalysisPage, props)))
    await click('库存分布')
    expect(node.textContent).toContain('1 个分组')
    expect(JSON.parse(contexts.at(-1)!).result.total).toBe(2)
    await click('warehouse')
    expect(JSON.parse(contexts.at(-1)!).selectedGroup).toBe('warehouse')
    expect(JSON.parse(contexts.at(-1)!).visibleRows).toHaveLength(2)
    vi.mocked(api.load).mockRejectedValueOnce(new Error('权限已撤回'))
    await click('刷新')
    expect(node.textContent).toContain('权限已撤回')
    expect(JSON.parse(contexts.at(-1)!).result).toBeUndefined()
  } finally {
    await act(async () => root.unmount())
  }
})
it('waits for the pane binding before reading a newly selected session', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div'),
    root = createRoot(node)
  const api = { list: vi.fn(async () => []), load: vi.fn(), preview: vi.fn(), save: vi.fn() } as AnalysisApi
  const props = {
    ...slotProps(),
    sessionId: 'binding-test',
    active: true,
    onDirtyChange: vi.fn(),
    onContext: vi.fn(),
    api,
  }
  try {
    await act(async () => root.render(h(AnalysisPage, { ...props, ready: false })))
    expect(api.list).not.toHaveBeenCalled()
    expect(node.textContent).toContain('正在关联会话')
    await act(async () => root.render(h(AnalysisPage, { ...props, ready: true })))
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(node.textContent).not.toContain('正在关联会话')
  } finally {
    await act(async () => root.unmount())
  }
})
it('keeps manual section edits in context, reorders by id, removes a section and saves the same complete report', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div'),
    root = createRoot(node),
    contexts: string[] = []
  const definition = { ...defaultDefinition(), kind: 'report' as const }
  const saved = { id: '00000000-0000-4000-8000-000000000003', version: 1, updatedAt: '', definition }
  const result = {
    groups: [],
    rows: [],
    total: 0,
    startedAt: '',
    fetchedAt: '2026-09-19T00:00:00Z',
    sourceTitle: '库存余额',
    groupLabel: '仓库',
    measureLabel: '记录数',
    notice: '',
  }
  const api = {
    list: vi.fn(async () => [saved]),
    load: vi.fn(async () => ({ document: saved, result })),
    preview: vi.fn(),
    save: vi.fn(async (r: { definition: typeof definition }) => ({
      document: { ...saved, version: 2, definition: r.definition },
      result,
    })),
  } as unknown as AnalysisApi
  const props = {
    ...slotProps(),
    sessionId: 'report-sections-test',
    active: true,
    onDirtyChange: vi.fn(),
    onContext: (c: { content?: string }) => contexts.push(c.content ?? ''),
    api,
  }
  const click = async (text: string) => {
    const button = [...node.querySelectorAll('button')].find(
      b =>
        b.getAttribute('aria-label') === text ||
        b.textContent?.trim() === text ||
        b.querySelector('strong')?.textContent === text,
    )
    expect(button).toBeTruthy()
    await act(async () => button!.click())
  }
  try {
    await act(async () => root.render(h(AnalysisPage, props)))
    await click(definition.title)
    const area = node.querySelector('textarea[aria-label="摘要"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '本次手工补充')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(JSON.parse(contexts.at(-1)!).definition.sections[0].body).toBe('本次手工补充')
    await click('上移第 3 节')
    expect(JSON.parse(contexts.at(-1)!).definition.sections.map((s: { id: string }) => s.id)).toEqual([
      'summary',
      'nextSteps',
      'findings',
    ])
    await click('删除第 3 节')
    await click('添加章节')
    const draft = JSON.parse(contexts.at(-1)!).definition
    expect(draft.summary).toBe('本次手工补充')
    expect(draft.sections.map((s: { title: string }) => s.title)).toEqual(['摘要', '后续行动', '新章节'])
    expect(JSON.parse(contexts.at(-1)!).dirty).toBe(true)
    await click('保存分析')
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ definition: draft, expectedVersion: 1 }))
    expect(JSON.parse(contexts.at(-1)!).dirty).toBe(false)
  } finally {
    await act(async () => root.unmount())
  }
})

it('retains unfinished reports across sessions, protects refresh even in another session, and keeps edits on save failure', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div'),
    root = createRoot(node),
    dirty = vi.fn(),
    contexts: string[] = []
  const definition = { ...defaultDefinition(), kind: 'report' as const }
  const saved = { id: '00000000-0000-4000-8000-000000000004', version: 7, updatedAt: '', definition }
  const api = {
    list: vi.fn(async () => [saved]),
    load: vi.fn(async () => ({
      document: saved,
      result: { groups: [], rows: [], total: 0, fetchedAt: '', notice: '' },
    })),
    preview: vi.fn(),
    save: vi.fn().mockRejectedValue(new Error('版本已更新，请核对')),
  } as unknown as AnalysisApi
  const props = {
    ...slotProps(),
    active: true,
    onDirtyChange: dirty,
    onContext: (c: { content?: string }) => contexts.push(c.content ?? ''),
    api,
    ready: true,
  }
  const render = async (sessionId: string) => act(async () => root.render(h(AnalysisSessions, { ...props, sessionId })))
  const visible = () => node.querySelector(':scope > div:not([hidden])')!
  const click = async (name: string) => {
    // A dialog is drawn at the end of the document, not inside the page that asked for it.
    const button = [...visible().querySelectorAll('button'), ...document.querySelectorAll('[role=dialog] button')].find(
      b => b.textContent?.includes(name),
    )
    expect(button).toBeTruthy()
    await act(async () => button!.click())
  }
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }
  const write = async (value: string) => {
    const area = visible().querySelector('textarea[aria-label="摘要"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  try {
    await render('retained-report-a')
    await click('库存分布')
    expect(unload()).toBe(false)
    await write('会话 A 未完成正文')
    expect(unload()).toBe(true)
    await render('retained-report-b')
    expect(visible().textContent).toContain('新建报告')
    expect(JSON.parse(contexts.at(-1)!).definition).toBeUndefined()
    expect(dirty).toHaveBeenLastCalledWith(true)
    expect(unload()).toBe(true)
    await render('retained-report-a')
    expect((visible().querySelector('textarea') as HTMLTextAreaElement).value).toBe('会话 A 未完成正文')
    expect(api.load).toHaveBeenCalledTimes(1)
    await click('保存分析')
    expect(visible().textContent).toContain('版本已更新')
    expect(unload()).toBe(true)
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 7 }))
    await click('返回列表')
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    await click('继续编辑')
    await write(definition.summary)
    expect(unload()).toBe(false)
    await write('待放弃')
    await click('返回列表')
    const discard = [...document.querySelector('[role=dialog]')!.querySelectorAll('button')].find(
      b => b.textContent === '放弃修改',
    )!
    await act(async () => discard.click())
    expect(visible().textContent).toContain('新建报告')
    expect(unload()).toBe(false)
  } finally {
    await act(async () => root.unmount())
    expect(unload()).toBe(false)
  }
})
