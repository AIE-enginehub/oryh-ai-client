// @vitest-environment jsdom

import { fakeFace, wordsOf } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { TodoChat } from './todo-chat.js'
import { words } from './words.js'

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
    const pane = fakeFace()
    const node = window.document.createElement('div')
    window.document.body.append(node)
    const root = createRoot(node)
    try {
      await act(async () =>
        root.render(h(TodoChat, { face: pane.face, api: api as never, todoId: 'b', t: wordsOf(words) })),
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
