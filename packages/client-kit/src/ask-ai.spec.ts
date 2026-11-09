// @vitest-environment jsdom
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { AskAi } from './ask.js'
import { RowOpenCell } from './ask-notes.js'
import { ChatActivityNote, waitingElsewhere } from './chat-context.js'
import { dictionaries } from './dictionary.js'
import type { PageFace } from './frame.js'
import { fakeFace, wordsOf } from './pane-test.js'

function mount(element: (face: PageFace) => ReturnType<typeof h>) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const paneAsk = vi.fn(async () => {})
  const showChat = vi.fn()
  const pane = fakeFace({
    remote: { paneAsk },
    frame: { chat: { startSession: () => false, showChat, showSession: () => {} } },
  })
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const render = () => act(async () => root.render(element(pane.face)))
  const type = (value: string) =>
    act(async () => {
      const box = document.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
  return {
    node,
    pane,
    paneAsk,
    showChat,
    render,
    type,
    click: (element: Element | null | undefined) => act(async () => (element as HTMLElement).click()),
    close: async () => {
      await act(async () => root.unmount())
      node.remove()
    },
  }
}

describe('「问 AI」 on a page', () => {
  it('says the question went only beside the record it was asked about', async () => {
    const page = mount(face => h(AskAi, { face, question: '请说明这条记录现在的情况。' }))
    const shows = (key: string) => act(async () => page.pane.local.setContext({ key, title: key }))
    try {
      await page.render()
      await shows('list-orders:a')
      await page.click(page.node.querySelector('button'))
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(page.node.querySelector('[role=status]')?.textContent).toContain('已发给 AI 助手')
      // The page opens another record, with the same button on it. Nothing was asked about this one.
      await shows('list-orders:b')
      expect(page.node.querySelector('[role=status]')).toBeNull()
      // It was said once: back on the first, it is not said again.
      await shows('list-orders:a')
      expect(page.node.querySelector('[role=status]')).toBeNull()
    } finally {
      await page.close()
    }
  })

  it('opens the question to be read and reworded, and sends what the person leaves in it', async () => {
    const page = mount(face => h(AskAi, { face, question: '请说明这条记录现在的情况。' }))
    try {
      await page.render()
      expect(document.querySelector('textarea')).toBeNull()
      await page.click(page.node.querySelector('button'))
      // Nothing has gone anywhere yet: the suggestion is there to read first.
      expect(document.querySelector('textarea')!.value).toBe('请说明这条记录现在的情况。')
      expect(page.paneAsk).not.toHaveBeenCalled()
      await page.type('  为什么这张单还没发货？ ')
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(page.paneAsk).toHaveBeenCalledWith({
        sessionId: 's',
        connectionId: 'c',
        question: '为什么这张单还没发货？',
      })
      expect(page.showChat).toHaveBeenCalled()
      expect(document.querySelector('textarea')).toBeNull()
      expect(page.node.textContent).toContain('已发给 AI 助手')
      // Opened again, it starts from the suggestion, not from what was sent.
      await page.click(page.node.querySelector('button'))
      expect(document.querySelector('textarea')!.value).toBe('请说明这条记录现在的情况。')
      // Emptied, there is nothing to send.
      await page.type('   ')
      expect([...document.querySelectorAll('button')].find(b => b.textContent === '发送')!.disabled).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('on a row of a list, says which row the question is about', async () => {
    const row = (face: PageFace) =>
      h(
        'table',
        null,
        h(
          'tbody',
          null,
          h(
            'tr',
            null,
            h(RowOpenCell, {
              face,
              title: 'SO202606002',
              onOpen: () => {},
              ask: { resource: 'sales-orders', id: 'so-7' },
            }),
          ),
        ),
      )
    const page = mount(row)
    try {
      await page.render()
      const ask = page.node.querySelector('button[aria-label="就“SO202606002”问 AI"]')
      expect(ask).not.toBeNull()
      await page.click(ask)
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(page.paneAsk).toHaveBeenCalledWith({
        sessionId: 's',
        connectionId: 'c',
        question: '请说明这条记录现在的情况，并指出需要我处理或注意的地方。',
        subject: { title: 'SO202606002', resource: 'sales-orders', id: 'so-7' },
      })
      // A row has no room for a sentence: the button says the question went, and a screen reader hears it.
      const status = page.node.querySelector('[role=status]')!
      expect(status.className).toBe('sr-only')
      expect(status.textContent).toContain('已发给 AI 助手')
      expect(page.node.querySelector('button')!.title).toContain('已发给 AI 助手')
    } finally {
      await page.close()
    }
  })
})

describe('a conversation that waits on the person while another is on show', () => {
  const waiting = { pendingInteraction: {} }
  it('is the one not on show, and none when the one that waits is in front of them', () => {
    const statuses = new Map<string, { pendingInteraction?: unknown; running?: boolean }>([
      ['chat', { running: true }],
      ['other', waiting],
    ])
    expect(waitingElsewhere(statuses, ['chat', 'chat'])).toBe('other')
    // The Chat on show waits itself: its own note says so, and there is nothing elsewhere.
    expect(waitingElsewhere(new Map([['chat', waiting]]), ['chat', 'chat'])).toBeUndefined()
    // A run of the Chat waits while the Chat is on show: that is elsewhere. Read in the main view, it is not.
    expect(waitingElsewhere(new Map([['run', waiting]]), ['chat', 'chat'])).toBe('run')
    expect(waitingElsewhere(new Map([['run', waiting]]), ['chat', 'run'])).toBeUndefined()
    expect(waitingElsewhere(new Map(), [undefined, undefined])).toBeUndefined()
  })
  it('is said on the page, and a click shows that conversation', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const showSession = vi.fn()
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    try {
      await act(async () =>
        root.render(
          h(ChatActivityNote, {
            t: wordsOf(dictionaries),
            activity: 'none',
            chat: { startSession: () => false, showChat: () => {}, showSession },
            elsewhere: 'other',
          }),
        ),
      )
      const note = node.querySelector('button')!
      expect(note.textContent).toBe('另一个对话在等你确认，点此查看')
      await act(async () => note.click())
      expect(showSession).toHaveBeenCalledWith('other')
    } finally {
      await act(async () => root.unmount())
      node.remove()
    }
  })
})
