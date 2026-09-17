// @vitest-environment jsdom

import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RecordsApiContext } from './api.js'
import { ProductPicker } from './product-picker.js'

vi.mock('@fluentui/react-components', () => ({
  Button: ({ appearance, size, children, ...props }: any) => h('button', props, children),
  Input: ({ onChange, ...props }: any) =>
    h('input', { ...props, onChange: (e: any) => onChange?.(e, { value: e.target.value }) }),
  Dialog: ({ open, children }: any) => (open ? h('div', { role: 'dialog' }, children) : null),
  ...Object.fromEntries(
    ['DialogSurface', 'DialogBody', 'DialogTitle', 'DialogContent', 'DialogActions'].map(n => [
      n,
      ({ children }: any) => h('div', null, children),
    ]),
  ),
}))
it('keeps cross-page choices, commits only on confirm, and discards cancelled edits', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const a = { id: 'a', name: 'Product A', code: 'A' },
    b = { id: 'b', name: 'Product B', code: 'B' },
    value = [a]
  const productSearch = vi.fn(async q => ({ rows: q.page === 1 ? [a] : [b], total: 2, pages: 2 })),
    onChange = vi.fn()
  const node = document.createElement('div'),
    root = createRoot(node)
  const click = async (text: string) =>
    act(async () =>
      Array.from(node.querySelectorAll('button'))
        .find(b => b.textContent === text)!
        .click(),
    )
  try {
    await act(async () =>
      root.render(
        h(
          RecordsApiContext.Provider,
          { value: { productSearch } as never },
          h(ProductPicker, { connectionId: 'c', value, onChange }),
        ),
      ),
    )
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="搜索并选择产品"]')!.click())
    expect(node.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true)
    await click('下一页')
    await act(async () => node.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
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
