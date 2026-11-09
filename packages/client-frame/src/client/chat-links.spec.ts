// @vitest-environment jsdom

import { fakeFace } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ChatRecordLinks, linkTarget, recordLink } from './chat-links.js'

describe('a record link in a Chat answer', () => {
  const origin = 'https://oryh.example.test'
  const id = '2df5ffdc-2924-4978-8ab1-ac335733d941'

  it("is the record's page in this enterprise's ORYH console", () => {
    expect(recordLink(`${origin}/console/objects/sales_order/${id}`, origin)).toEqual({ type: 'sales_order', id })
    // The agent may name the collection where the console names the type; the Host reads either.
    expect(recordLink(`${origin}/console/objects/sales-orders/${id}/`, `${origin}/`)).toEqual({
      type: 'sales-orders',
      id,
    })
  })

  it('is nothing else: another site, another page of the console, an address that is not one', () => {
    for (const href of [
      `https://elsewhere.example.test/console/objects/sales_order/${id}`,
      `${origin}/console/objects/sales_order`,
      `${origin}/console/objects/sales_order/${id}/edit`,
      `${origin}/console/settings`,
      `${origin}/console/objects/../${id}`,
      'not a url',
      '',
    ])
      expect(recordLink(href, origin)).toBeUndefined()
    expect(recordLink(`${origin}/console/objects/sales_order/${id}`, 'not an origin')).toBeUndefined()
  })

  it('goes to the pane when a page shows that kind of record, and straight to the console when none does', () => {
    const shown = ['sales-orders', 'sales_order', 'timesheet-headers', 'timesheet_header']
    expect(linkTarget('sales_order', shown)).toBe('pane')
    expect(linkTarget('sales-orders', shown)).toBe('pane')
    // No page shows invoices here: the click itself opens the console, with no answer to wait for.
    expect(linkTarget('invoice', shown)).toBe('console')
    // Until the Host has said what it shows, it is asked.
    expect(linkTarget('invoice', undefined)).toBe('pane')
  })
})

describe('a click on a record link', () => {
  it('says how the last click went, not how one it replaced did', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const origin = 'https://oryh.example.test'
    const seat = document.createElement('div')
    seat.className = 'oryh-chat-seat'
    seat.innerHTML = `<a href="${origin}/console/objects/timesheet_header/abc">工时单</a>`
    const node = document.createElement('div')
    document.body.append(seat, node)
    const answers: ((result: { opened: boolean; notice?: string }) => void)[] = []
    const paneOpenRecord = vi.fn(() => new Promise(resolve => answers.push(resolve)))
    const root = createRoot(node)
    const click = () =>
      act(async () => {
        seat.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      })
    try {
      const { face } = fakeFace({ connection: { id: 'c', origin }, remote: { paneOpenRecord } })
      await act(async () => root.render(h(ChatRecordLinks, { face })))
      // Clicked over a form the page would not leave, then again once the form was out of the way.
      await click()
      await click()
      expect(paneOpenRecord).toHaveBeenCalledTimes(2)
      // The second opens the record. The first, which it replaced on the Host, then comes back saying so.
      await act(async () => answers[1]!({ opened: true }))
      await act(async () => answers[0]!({ opened: false, notice: '已被新的指令取代。' }))
      expect(seat.querySelector('.chat-link-note')).toBeNull()
      // A click that is the last one made and did not open the record is said.
      await click()
      await act(async () => answers[2]!({ opened: false, notice: '工时表单有未保存的修改，没有切换。' }))
      expect(seat.querySelector('.chat-link-note')?.textContent).toContain('没有切换')
    } finally {
      await act(async () => root.unmount())
      node.remove()
      seat.remove()
    }
  })
})
