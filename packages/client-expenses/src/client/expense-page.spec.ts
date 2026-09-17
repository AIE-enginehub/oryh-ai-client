// @vitest-environment jsdom
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpensePage } from './expense-page.js'

vi.mock('@fluentui/react-components', () => ({
  Button: ({ appearance, children, ...props }: any) => h('button', props, children),
}))
vi.mock('@oryh/dsh-client-frame/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@oryh/dsh-client-frame/client')>()
  return {
    ...actual,
    BusinessPage: ({ tabs, actions, active, onContext }: any) => {
      onContext({ key: 'my-expense-claims:list', title: '费用申请', detail: '', scope: '' })
      return h('div', { 'data-list': active }, tabs, actions)
    },
    NewButton: ({ onClick, children }: any) => h('button', { onClick }, children),
    useText: () => (key: string) => key,
    useBusinessText: () => (key: string) => key,
  }
})
vi.mock('./expenses.js', () => ({
  ExpensePanel: ({ active, newRequest, onContext }: any) => {
    onContext({ key: 'my-expense-claims:drafts', title: '本地草稿', detail: '', scope: '' })
    return h('div', { 'data-drafts': active }, `drafts ${newRequest}`)
  },
}))

const connection = (permissions: string[]) =>
  ({
    id: 'c',
    origin: 'https://oryh.example',
    identity: { permissions, tenant: { id: 't', name: '晶诚' }, user: { id: 'u', email: 'a@b', employeeId: 'e' } },
  }) as unknown as ConnectionSummary

describe('the expense page', () => {
  beforeEach(() => localStorage.clear())
  it('offers the drafts view only to someone who may keep drafts, and reports the view on screen', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    const contexts: string[] = []
    try {
      await act(async () =>
        root.render(
          h(ExpensePage, {
            connection: connection([]),
            active: true,
            onDirtyChange: () => {},
            onContext: value => contexts.push(value.key),
          }),
        ),
      )
      expect(node.querySelector('[role="group"]')).toBeNull()
      expect(node.textContent).not.toContain('drafts')
      await act(async () =>
        root.render(
          h(ExpensePage, {
            connection: connection(['expense.submit_own']),
            active: true,
            onDirtyChange: () => {},
            onContext: value => contexts.push(value.key),
          }),
        ),
      )
      expect(contexts.at(-1)).toBe('my-expense-claims:list')
      // New claim: the drafts view opens and is asked for a new draft.
      const buttons = [...node.querySelectorAll('button')]
      await act(async () => buttons.find(b => b.textContent === 'text57')!.click())
      expect(node.textContent).toContain('drafts 1')
      expect(node.querySelector('[data-drafts="true"]')).not.toBeNull()
      expect(node.querySelector('[data-list="false"]')).not.toBeNull()
      expect(contexts.at(-1)).toBe('my-expense-claims:drafts')
    } finally {
      await act(async () => root.unmount())
      node.remove()
    }
  })
})
