// @vitest-environment jsdom

import { fakeFace, wordsOf } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProductPicker } from './product-picker.js'
import { words } from './words.js'

it('keeps cross-page choices, commits only on confirm, and discards cancelled edits', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const a = { id: 'a', name: 'Product A', code: 'A' },
    b = { id: 'b', name: 'Product B', code: 'B' },
    value = [a]
  const productSearch = vi.fn(async q => ({ rows: q.page === 1 ? [a] : [b], total: 2, pages: 2 })),
    onChange = vi.fn()
  const { face } = fakeFace({ connection: { id: 'c' } })
  const node = document.createElement('div'),
    root = createRoot(node)
  const click = async (text: string) =>
    act(async () =>
      // The dialog is drawn at the end of the document, not inside the field that opens it.
      [...node.querySelectorAll('button'), ...document.querySelectorAll('[role=dialog] button')]
        .find(b => b.textContent === text)!
        .click(),
    )
  try {
    await act(async () =>
      root.render(h(ProductPicker, { api: { productSearch } as never, face, t: wordsOf(words), value, onChange })),
    )
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="搜索并选择产品"]')!.click())
    expect(document.querySelector<HTMLInputElement>('[role=dialog] input[type=checkbox]')!.checked).toBe(true)
    await click('下一页')
    await act(async () => document.querySelector<HTMLInputElement>('[role=dialog] input[type=checkbox]')!.click())
    expect(onChange).not.toHaveBeenCalled()
    await click('确定选择（2）')
    expect(onChange).toHaveBeenCalledWith([a, b])
    onChange.mockClear()
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="搜索并选择产品"]')!.click())
    await click('清空选择')
    await click('取消')
    expect(onChange).not.toHaveBeenCalled()
    expect(node.textContent).toContain('已选 1 个产品')
  } finally {
    await act(async () => root.unmount())
  }
})
