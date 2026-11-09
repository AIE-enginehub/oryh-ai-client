// @vitest-environment jsdom
import { fakeFace, wordsOf } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CollectionPanel } from './collection.js'
import { english } from './en.js'

it('translates builtin labels in generic collection columns and record details without changing values', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { face } = fakeFace({ frame: { t: ((key: string) => (key === 'interfaceLanguage' ? 'en' : key)) as never } })
  const view = {
    id: 'english-collection',
    label: 'Sales quotations',
    collection: 'sales-quotations',
    filters: { status: 'submitted' },
    display: { columns: [{ field: 'id', label: '编号' }] },
  }
  const row = { id: 'q1', title: 'QT-000001', fields: [{ field: 'id', label: '编号', value: 'q1' }] }
  const api = {
    collectionList: vi.fn(async () => ({ rows: [row], total: 1, page: 1, pages: 1, fetchedAt: '' })),
    recordDetail: vi.fn(async () => ({ children: [] })),
  }
  const node = document.createElement('div'),
    root = createRoot(node)
  try {
    await act(async () =>
      root.render(
        h(CollectionPanel, {
          view,
          columns: ['id'],
          onColumns: vi.fn(),
          api: api as never,
          face,
          t: wordsOf(english),
          onContext: vi.fn(),
        }),
      ),
    )
    expect(node.querySelector('th')?.textContent).toBe('ID')
    expect(node.textContent).not.toContain('编号')
    expect(node.textContent).toContain('Status: Submitted')
    expect(node.textContent).not.toContain('状态')
    expect(node.textContent).not.toContain('已提交')
    await act(async () => (node.querySelector('.record-link') as HTMLButtonElement).click())
    expect(node.querySelector('dt')?.textContent).toBe('ID')
    expect(node.querySelector('dd')?.textContent).toBe('q1')
    expect(node.textContent).not.toContain('编号')
  } finally {
    await act(async () => root.unmount())
  }
})
