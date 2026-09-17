// @vitest-environment jsdom
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProjectsApiContext } from './api.js'
import { ProjectPanel } from './projects.js'

vi.mock('@oryh/dsh-client-frame/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@oryh/dsh-client-frame/client')>()
  return {
    ...actual,
    BusinessPage: ({ actions }: any) => h('div', null, actions),
    NewButton: ({ onClick, children }: any) => h('button', { onClick }, children),
    useText: () => (key: string) => key,
  }
})
vi.mock('@fluentui/react-components', () => ({
  Spinner: () => null,
  MessageBar: ({ children }: any) => h('div', { role: 'alert' }, children),
  MessageBarBody: ({ children }: any) => h('span', null, children),
  Button: ({ appearance, icon, children, ...props }: any) => h('button', { type: 'button', ...props }, children),
  Dialog: ({ open, children }: any) => (open ? h('div', { role: 'dialog' }, children) : null),
  ...Object.fromEntries(
    ['DialogSurface', 'DialogBody', 'DialogTitle', 'DialogContent', 'DialogActions'].map(n => [
      n,
      ({ children }: any) => h('div', null, children),
    ]),
  ),
}))
it('requires a separate explicit confirmation and leaves failures in the form', async () => {
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
    .mockImplementation(async (_c, fields) => ({
      id: 'p',
      revision: 1,
      state: 'review',
      fields,
      token: 'confirmation',
      expiresAt: Date.now() + 10000,
      message: 'review',
    }))
  const confirm = vi.fn().mockResolvedValue({
    id: 'p',
    revision: 3,
    state: 'created',
    fields: { project_name: 'Project' },
    message: '项目已创建。',
  })
  const api = {
    projectOptions: async () => ({ canCreate: true }),
    projectHistory: async () => [],
    projectPrepare: prepare,
    projectConfirm: confirm,
  }
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  try {
    await act(async () =>
      root.render(
        h(
          ProjectsApiContext.Provider,
          { value: api as never },
          h(ProjectPanel, {
            connection: {
              id: 'c',
              identity: { tenant: { name: 'Test' }, user: { email: 'test@example.invalid' } },
            } as never,
            active: true,
            columns: ['name'],
            onColumns: () => {},
            onDirtyChange: () => {},
            onContext: () => {},
          }),
        ),
      ),
    )
    await act(async () => node.querySelector('button')!.click())
    const form = node.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => reject(Error('项目编码已存在')))
    expect(form.querySelector('[role=alert]')?.textContent).toBe('项目编码已存在')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(node.querySelector('[role=dialog]')?.textContent).toContain('确认创建项目')
    expect(confirm).not.toHaveBeenCalled()
    await act(async () =>
      Array.from(node.querySelectorAll('button'))
        .find(b => b.textContent === '确认创建')!
        .click(),
    )
    expect(confirm).toHaveBeenCalledWith('c', 'p', 1, 'confirmation')
    expect(node.textContent).toContain('项目已创建。')
  } finally {
    await act(async () => root.unmount())
    node.remove()
  }
})
