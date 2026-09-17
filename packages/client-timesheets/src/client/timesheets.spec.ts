// @vitest-environment jsdom

import { dictionaries, fakePane, LocaleContext, PaneValueContext, RemoteContext } from '@oryh/dsh-client-frame/client'
import type { PaneNavigation } from '@oryh/dsh-pane/types'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { TimesheetsApiContext } from './api.js'
import { TimesheetPanel } from './timesheets.js'

// Test the business interaction; native Fluent rendering is checked in the browser.
vi.mock('@fluentui/react-components', () => ({
  Button: ({ appearance, size, icon, children, ...props }: any) => h('button', { type: 'button', ...props }, children),
  Field: ({ label, children }: any) => h('label', null, label, children),
  Input: ({ contentBefore, onChange, ...props }: any) =>
    h('input', { ...props, onChange: (e: any) => onChange?.(e, { value: e.target.value }) }),
  Select: ({ children, ...props }: any) => h('select', props, children),
  Spinner: () => null,
  MessageBar: ({ children }: any) => h('div', { role: 'alert' }, children),
  MessageBarBody: ({ children }: any) => h('span', null, children),
  Dialog: ({ open, children }: any) => (open ? h('div', { role: 'dialog' }, children) : null),
  ...Object.fromEntries(
    ['DialogActions', 'DialogBody', 'DialogContent', 'DialogSurface', 'DialogTitle'].map(name => [
      name,
      ({ children }: any) => h('div', null, children),
    ]),
  ),
}))
// The Chat card is its own component; here the panel's behaviour is what is under test.
vi.mock('./timesheet-chat.js', () => ({ TimesheetChat: () => null }))

const connection = (permissions: string[]) =>
  ({ id: 'c', identity: { permissions, tenant: { name: 'Test' }, user: { email: 'test@example.invalid' } } }) as never
const options = {
  workTypes: [{ name: 'regular', title: '正常工时' }],
  projects: [],
  requirements: [],
  submitStates: ['draft'],
  editableStates: ['draft'],
}
/** The panel inside a pane the test drives, with the props every test shares. */
function mount(
  api: Record<string, unknown>,
  props: Partial<Parameters<typeof TimesheetPanel>[0]> & { permissions?: string[] } = {},
) {
  const pane = fakePane()
  const onContext = vi.fn()
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const { permissions = ['timesheet.submit_own', 'approval.record'], ...rest } = props
  const render = () =>
    act(async () =>
      root.render(
        h(
          PaneValueContext.Provider,
          { value: pane.value },
          h(
            TimesheetsApiContext.Provider,
            { value: api as never },
            // The same fake answers the frame's calls (the review clear) and the domain's.
            h(
              RemoteContext.Provider,
              { value: api as never },
              h(
                LocaleContext.Provider,
                { value: k => dictionaries[k] },
                h(TimesheetPanel, {
                  connection: connection(permissions),
                  manager: false,
                  active: true,
                  onDirtyChange: () => {},
                  onContext,
                  ...rest,
                }),
              ),
            ),
          ),
        ),
      ),
    )
  /** The agent asks to open a timesheet, or the blank form. */
  const open = (id: string, payload: Partial<PaneNavigation> = {}) =>
    act(async () => {
      pane.command({
        lane: 'navigation',
        id,
        page: 'timesheets',
        payload: { target: 'timesheet', page: 'timesheets', ...payload },
      })
    })
  const click = (text: string) =>
    act(async () =>
      Array.from(node.querySelectorAll('button'))
        .find(b => b.textContent === text)!
        .click(),
    )
  return {
    node,
    pane,
    onContext,
    render,
    open,
    click,
    /** The unsaved form as the page last reported it to Chat. */
    form: () => onContext.mock.lastCall?.[0].timesheet?.fields,
    close: async () => {
      await act(async () => root.unmount())
      node.remove()
    },
  }
}

describe('timesheet save feedback', () => {
  it('shows pending and failure beside save, preserves input, and opens review after retry', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    let reject!: (e: Error) => void
    const prepare = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, r) => {
            reject = r
          }),
      )
      .mockResolvedValue({
        id: 'review',
        action: { kind: 'create', fields: { period_start: '2026-09-09', period_end: '2026-09-09', entries: [] } },
        expiresAt: Date.now() + 60000,
      })
    const confirm = vi.fn()
    const f = mount(
      {
        timesheetList: async () => [],
        timesheetOptions: async () => ({ ...options, workTypes: [], submitStates: [], editableStates: [] }),
        timesheetHistory: async () => [],
        timesheetPrepare: prepare,
        timesheetConfirm: confirm,
      },
      { active: false },
    )
    try {
      await f.render()
      await f.click('新建工时单')
      const form = f.node.querySelector('form')!,
        before = Array.from(form.querySelectorAll('input,select,textarea')).map(e => (e as HTMLInputElement).value)
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(form.querySelector('[role=status]')?.textContent).toBe('正在核对…')
      expect(form.querySelector('fieldset')?.disabled).toBe(true)
      await act(async () => reject(Error('这个期间已有工时单')))
      expect(form.querySelector('.oryh-ts-save-feedback [role=alert]')?.textContent).toBe('这个期间已有工时单')
      expect(
        Array.from(form.querySelectorAll('input,select,textarea')).map(e => (e as HTMLInputElement).value),
      ).toEqual(before)
      expect(form.querySelector('fieldset')?.disabled).toBe(false)
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(document.querySelector('[role=dialog]')?.textContent).toContain('核对本次操作')
      expect(confirm).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
})

describe('existing timesheet view modes', () => {
  it.each([true, false])('opens the requested record with server-controlled editability (%s)', async canEdit => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const detail = {
      canEdit,
      header: {
        id: 'h',
        employee_id: 'employee',
        period_start: '2026-09-01',
        period_end: '2026-09-01',
        status: canEdit ? 'draft' : 'submitted',
        source_report_text: '',
      },
      entries: [
        {
          id: 'line',
          work_date: '2026-09-01',
          hours: 8,
          work_type: 'regular',
          project_id: '',
          task: 'existing work',
          notes: '',
        },
      ],
      approval_records: [],
    }
    const detailCall = vi.fn().mockResolvedValue(detail)
    const f = mount({
      timesheetList: async () => [],
      timesheetOptions: async () => options,
      timesheetHistory: async () => [],
      timesheetDetail: detailCall,
    })
    try {
      await f.render()
      await f.open('open', { headerId: 'h' })
      expect(detailCall).toHaveBeenCalledWith('c', 'h', undefined)
      expect(f.pane.acked()).toEqual(['open'])
      expect(f.node.textContent).toContain(canEdit ? '编辑工时' : '工时详情 · 只读')
      expect(f.node.querySelectorAll('form input[type=number]').length).toBe(canEdit ? 1 : 0)
      if (canEdit)
        expect(Array.from(f.node.querySelectorAll('input')).some(e => e.value === 'existing work')).toBe(true)
      else expect(f.node.textContent).toContain('existing work')
      // What the page reports is the document that is open, so the agent's wait can settle on it.
      expect(f.onContext.mock.lastCall?.[0].timesheet).toMatchObject({ manager: false, headerId: 'h' })
    } finally {
      await f.close()
    }
  })
})

describe('whole document editing', () => {
  it('stages add/delete, restores a removed row, and saves once with all remaining rows', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const detail = {
      revision: 'version',
      canEdit: true,
      header: {
        id: 'h',
        employee_id: 'e',
        period_start: '2026-09-01',
        period_end: '2026-09-01',
        status: 'draft',
        source_report_text: '',
      },
      entries: [
        { id: 'a', work_date: '2026-09-01', hours: 8, work_type: 'regular', project_id: '', task: 'A', notes: '' },
        { id: 'b', work_date: '2026-09-01', hours: 4, work_type: 'regular', project_id: '', task: 'B', notes: '' },
      ],
      approval_records: [],
    }
    const prepare = vi.fn().mockRejectedValue(Error('请检查工时'))
    const f = mount(
      {
        timesheetList: async () => [],
        timesheetOptions: async () => options,
        timesheetHistory: async () => [],
        timesheetDetail: async () => detail,
        timesheetPrepare: prepare,
      },
      { permissions: ['timesheet.submit_own'] },
    )
    try {
      await f.render()
      await f.open('open', { headerId: 'h' })
      await act(async () => f.node.querySelector<HTMLButtonElement>('[aria-label="删除第 1 条明细"]')!.click())
      expect(f.node.querySelectorAll('.timesheet-entry')).toHaveLength(1)
      expect(prepare).not.toHaveBeenCalled()
      await f.click('撤销删除')
      expect(f.node.querySelectorAll('.timesheet-entry')).toHaveLength(2)
      await f.click('添加明细')
      expect(f.node.querySelectorAll('.timesheet-entry')).toHaveLength(3)
      await act(async () => f.node.querySelector<HTMLButtonElement>('[aria-label="删除第 2 条明细"]')!.click())
      await act(async () =>
        f.node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      )
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(prepare.mock.calls[0]![1]).toMatchObject({
        kind: 'update',
        headerId: 'h',
        expectedRevision: 'version',
        fields: { entries: [{ id: 'a', task: 'A' }, { hours: 0 }] },
      })
      expect(prepare.mock.calls[0]![1].fields.entries[1]).not.toHaveProperty('id')
      expect(f.node.querySelectorAll('.timesheet-entry')).toHaveLength(2)
      expect(f.node.querySelector('.oryh-ts-save-feedback [role=alert]')?.textContent).toBe('请检查工时')
      await f.click('放弃修改')
      expect(Array.from(f.node.querySelectorAll('input')).map(n => n.value)).toContain('B')
    } finally {
      await f.close()
    }
  })
})

describe('following writes made in Chat', () => {
  async function openDraft() {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const draft = {
      canEdit: true,
      revision: 'v1',
      header: {
        id: 'h',
        employee_id: 'e',
        period_start: '2026-09-07',
        period_end: '2026-09-11',
        status: 'draft',
        source_report_text: '',
      },
      entries: [
        { id: 'a', work_date: '2026-09-07', hours: 8, work_type: 'regular', project_id: '', task: '装配', notes: '' },
      ],
      approval_records: [],
    }
    const submitted = { ...draft, canEdit: false, header: { ...draft.header, status: 'submitted' } }
    let current: typeof draft = draft
    const api = {
      timesheetList: vi.fn(async () => [current.header]),
      timesheetOptions: async () => options,
      timesheetHistory: async () => [],
      timesheetDetail: vi.fn(async () => current),
    }
    const f = mount(api, { permissions: ['timesheet.submit_own'] })
    await f.render()
    await f.open('open', { headerId: 'h' })
    return {
      ...f,
      api,
      /** The Host moves the marker after a turn that wrote. */
      write: (id: string) =>
        act(async () => {
          f.pane.state({ serverChange: { id, at: Date.now() } })
        }),
      submit: () => {
        current = submitted
      },
    }
  }
  it('turns the open draft into its submitted detail once Chat submits it, without closing it', async () => {
    const f = await openDraft()
    try {
      expect(f.node.querySelectorAll('form input[type=number]')).toHaveLength(1)
      f.submit()
      await f.write('turn-1')
      expect(f.api.timesheetDetail).toHaveBeenCalledTimes(2)
      expect(f.node.querySelector('h1')?.textContent).toBe('2026-09-07 — 2026-09-11')
      expect(f.node.querySelector('.page-title .record-status')?.textContent).toBe('已提交')
      expect(f.node.querySelectorAll('form input[type=number]')).toHaveLength(0)
      expect(f.node.textContent).toContain('工时详情 · 只读')
    } finally {
      await f.close()
    }
  })
  it('keeps unsaved edits when Chat writes, and lets the person choose to see the server version', async () => {
    const f = await openDraft()
    try {
      const task = f.node.querySelector<HTMLInputElement>('input[placeholder="具体完成了什么工作"]')!
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setValue.call(task, '改过的内容')
        task.dispatchEvent(new Event('input', { bubbles: true }))
      })
      f.submit()
      await f.write('turn-1')
      // The list re-read, but the form with its unsaved edit is left exactly as it was.
      expect(f.api.timesheetDetail).toHaveBeenCalledTimes(1)
      expect(f.node.querySelector<HTMLInputElement>('input[placeholder="具体完成了什么工作"]')?.value).toBe(
        '改过的内容',
      )
      expect(f.node.textContent).toContain('服务端数据可能已在 Chat 中更新')
      await f.click('放弃修改并刷新')
      expect(f.api.timesheetDetail).toHaveBeenCalledTimes(2)
      expect(f.node.querySelector('.page-title .record-status')?.textContent).toBe('已提交')
      expect(f.node.textContent).not.toContain('服务端数据可能已在 Chat 中更新')
    } finally {
      await f.close()
    }
  })
  it('gives up a draft Chat already wrote for the saved timesheet, but only while the form is still what the agent saw', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const submitted = {
      canEdit: false,
      header: {
        id: 'h',
        employee_id: 'e',
        period_start: '2026-09-14',
        period_end: '2026-09-18',
        status: 'submitted',
        source_report_text: '',
      },
      entries: [],
      approval_records: [],
    }
    const api = {
      timesheetList: async () => [submitted.header],
      timesheetOptions: async () => ({ ...options, workTypes: [] }),
      timesheetHistory: async () => [],
      timesheetDetail: vi.fn(async () => submitted),
    }
    const f = mount(api, { permissions: ['timesheet.submit_own'] })
    try {
      await f.render()
      await f.open('new')
      expect(f.node.textContent).toContain('未保存')
      const form = JSON.stringify(f.form())
      await f.open('stale', {
        headerId: 'h',
        discardForm: JSON.stringify({ ...JSON.parse(form), source_report_text: 'agent 看到的旧内容' }),
      })
      expect(api.timesheetDetail).not.toHaveBeenCalled()
      expect(f.node.textContent).toContain('当前有未保存修改')
      await f.open('open', { headerId: 'h', discardForm: form })
      expect(api.timesheetDetail).toHaveBeenCalledWith('c', 'h', undefined)
      expect(f.node.querySelector('.page-title .record-status')?.textContent).toBe('已提交')
    } finally {
      await f.close()
    }
  })
})
