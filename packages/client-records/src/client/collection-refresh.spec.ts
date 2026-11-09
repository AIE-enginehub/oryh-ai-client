// @vitest-environment jsdom
import { fakeFace, wordsOf } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CollectionPanel } from './collection.js'
import { english } from './en.js'

it('keeps an open record in step when the list re-reads after a Chat write', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { face, state } = fakeFace({
    frame: { t: ((key: string) => (key === 'interfaceLanguage' ? 'en' : key)) as never },
  })
  const view = {
    id: 'refresh-collection',
    label: 'Orders',
    collection: 'sales-orders',
    filters: {},
    display: {
      columns: [
        { field: 'id', label: 'ID' },
        { field: 'title', label: 'Title' },
      ],
    },
  }
  const before = {
    id: 'o1',
    title: 'SO-1',
    fields: [
      { field: 'id', label: 'ID', value: 'o1' },
      { field: 'title', label: 'Title', value: 'SO-1' },
    ],
  }
  const after = {
    ...before,
    title: 'SO-1 (submitted)',
    fields: [
      { field: 'id', label: 'ID', value: 'o1' },
      { field: 'title', label: 'Title', value: 'SO-1 (submitted)' },
    ],
  }
  let rows = [before]
  const api = {
    collectionList: vi.fn(async () => ({ rows, total: 1, page: 1, pages: 1, fetchedAt: '' })),
    recordDetail: vi.fn(async () => ({ children: [] })),
  }
  const node = document.createElement('div'),
    root = createRoot(node)
  try {
    await act(async () =>
      root.render(
        h(CollectionPanel, {
          view,
          columns: ['id', 'title'],
          onColumns: vi.fn(),
          api: api as never,
          face,
          t: wordsOf(english) as never,
          onContext: vi.fn(),
        }),
      ),
    )
    await act(async () => (node.querySelector('.record-link') as HTMLButtonElement).click())
    expect(node.textContent).toContain('SO-1')
    expect(node.textContent).not.toContain('SO-1 (submitted)')

    rows = [after]
    await act(async () => state({ serverChange: { id: 'change-1', at: Date.now() } }))
    await vi.waitFor(() => expect(node.textContent).toContain('SO-1 (submitted)'))
    expect(api.collectionList).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
  }
})
