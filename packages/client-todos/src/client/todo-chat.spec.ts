// @vitest-environment jsdom

import { BusinessSessionContext, fakePane, PaneValueContext } from '@oryh/dsh-client-frame/client'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { TodosApiContext } from './api.js'
import { TodoChat } from './todo-chat.js'

vi.mock('@fluentui/react-components', () => ({
  Button: ({ children, onClick }: any) => h('button', { onClick }, children),
}))
describe('the open todo beside Chat', () => {
  it('shows the linked document through the shared Remote, and re-reads it after a write in Chat', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const document = {
      todoId: 'b',
      title: 'First visible',
      entityType: 'sales_quotation',
      fetchedAt: new Date().toISOString(),
      sections: [{ name: 'quotation', fields: [{ name: 'quote_number', value: 'QT-1' }] }],
    }
    const api = { todoDetail: vi.fn(async () => document) }
    const pane = fakePane()
    const node = window.document.createElement('div')
    window.document.body.append(node)
    const root = createRoot(node)
    try {
      await act(async () =>
        root.render(
          h(
            TodosApiContext.Provider,
            { value: api as never },
            h(
              PaneValueContext.Provider,
              { value: pane.value },
              h(
                BusinessSessionContext.Provider,
                { value: 's' },
                h(TodoChat, { connectionId: 'c' as never, todoId: 'b' }),
              ),
            ),
          ),
        ),
      )
      expect(node.textContent).toContain('QT-1')
      expect(node.textContent).toContain('Chat 已关联当前待办')
      expect(api.todoDetail).toHaveBeenCalledTimes(1)
      // The marker moving after a turn is the signal to read the document again.
      await act(async () => {
        pane.state({ serverChange: { id: 'turn-1', at: Date.now() } })
      })
      expect(api.todoDetail).toHaveBeenCalledTimes(2)
      await act(async () => {
        pane.publish({ status: 'rejected', error: '会话尚未绑定企业。' })
      })
      expect(node.textContent).toContain('会话尚未绑定企业。')
    } finally {
      await act(async () => root.unmount())
      node.remove()
    }
  })
})
