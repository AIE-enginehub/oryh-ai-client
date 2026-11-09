// @vitest-environment jsdom

import { dictionaries } from '@oryh/ai-client-kit/dictionary'
import { wordsOf } from '@oryh/ai-client-kit/testing'
import { IconChecklist, IconShoppingCart } from '@tabler/icons-react'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BusinessMenu } from './navigation.js'
import { ClientPages } from './pages-registry.js'

it('offers 我的待办 and what the person had made, and none of the other built-in pages', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const pages = new ClientPages()
  pages.register({ page: 'my-open-todos', order: 10, group: 'work', icon: IconChecklist, label: () => '我的待办' })
  pages.register({ page: 'sales-orders', order: 50, icon: IconShoppingCart, label: () => '销售订单' })
  pages.register({ page: 'analytics', order: 60, group: 'insights', icon: IconChecklist, label: () => '自定义页面' })
  const identity = {
    company: '企业',
    email: '',
    allowedPages: ['my-open-todos', 'sales-orders', 'analytics'],
    views: [
      { id: 'role-invoices', label: '发票·工资条', collection: 'invoices', origin: 'role' as const },
      { id: 'page', label: '本月销售', collection: 'custom-pages' },
      { id: 'v', label: '待处理订单', collection: 'sales-orders' },
      { id: 'legacy', label: '旧视图' },
    ],
  }
  const navigate = vi.fn(),
    node = document.createElement('div'),
    root = createRoot(node)
  const render = (compact: boolean, extra: object = {}) =>
    root.render(
      h(BusinessMenu, {
        pages: pages.getSnapshot().pages,
        identity: { ...identity, ...extra },
        current: 'my-open-todos',
        compact,
        navigate,
        t: key => dictionaries[key],
      }),
    )
  const within = (group: string) =>
    [...node.querySelectorAll(`[role=group][aria-label="${group}"] button`)].map(b => b.getAttribute('aria-label'))
  try {
    await act(async () => render(false))
    expect([...node.querySelectorAll('[role=group]')].map(e => e.getAttribute('aria-label'))).toEqual([
      '我的工作',
      '我的视图',
    ])
    expect(within('我的工作')).toEqual(['我的待办'])
    // Their custom pages and lists, not the lists their role implies.
    expect(within('我的视图')).toEqual(['本月销售', '待处理订单', '旧视图'])
    // A list over a built-in page's collection still wears that page's icon, though the page has no entry.
    const icon = (label: string) =>
      [...(node.querySelector(`button[aria-label="${label}"] svg`)?.classList ?? [])].find(c =>
        c.startsWith('tabler-icon-'),
      )
    expect(icon('待处理订单')).toBe('tabler-icon-shopping-cart')
    expect(icon('旧视图')).toBe('tabler-icon-bookmark')
    // Connection belongs to the user menu for desktop and server deployments alike.
    expect(node.querySelector('button[aria-label="企业连接"]')).toBeNull()
    await act(async () => render(false, { signOut: () => {} }))
    expect(node.querySelector('button[aria-label="企业连接"]')).toBeNull()
    await act(async () => render(true))
    expect(node.querySelectorAll('.oryh-menu-label, .oryh-menu-group-label')).toHaveLength(0)
    expect(node.querySelector('button[aria-label="企业连接"]')).toBeNull()
    const todos = node.querySelector<HTMLButtonElement>('button[aria-label="我的待办"]')!
    expect(todos.getAttribute('aria-current')).toBe('page')
    expect(todos.title).toBe('我的待办')
    await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="本月销售"]')!.click())
    expect(navigate).toHaveBeenLastCalledWith('view:page')
    // An account that may not open the page gets no entry for it.
    await act(async () => render(false, { allowedPages: [] }))
    expect(node.querySelector('button[aria-label="我的待办"]')).toBeNull()
    expect(node.querySelector('[aria-label="我的工作"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})

it('lists what colleagues shared in a group of its own, saying whose each is', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const pages = new ClientPages()
  pages.register({ page: 'my-open-todos', order: 10, group: 'work', icon: IconChecklist, label: () => '我的待办' })
  const identity = {
    company: '企业',
    email: '',
    allowedPages: ['my-open-todos'],
    signOut: () => {},
    views: [
      { id: 'theirs', label: '入库单', collection: 'shipments', origin: 'shared' as const, sharedBy: '王强' },
      { id: 'mine', label: '入库单', collection: 'shipments' },
    ],
  }
  const navigate = vi.fn(),
    node = document.createElement('div'),
    root = createRoot(node)
  try {
    await act(async () =>
      root.render(
        h(BusinessMenu, {
          pages: pages.getSnapshot().pages,
          identity,
          current: 'my-open-todos',
          compact: false,
          navigate,
          t: wordsOf(dictionaries),
        }),
      ),
    )
    expect([...node.querySelectorAll('[role=group]')].map(e => e.getAttribute('aria-label'))).toEqual([
      '我的工作',
      '我的视图',
      '同事共享的',
    ])
    // The same name as the person's own: told apart by the group, and by who shared it.
    const shared = node.querySelector<HTMLButtonElement>('[role=group][aria-label="同事共享的"] button')!
    expect(shared.getAttribute('aria-label')).toBe('入库单（王强 共享）')
    expect(shared.textContent).toBe('入库单')
    await act(async () => shared.click())
    expect(navigate).toHaveBeenLastCalledWith('view:theirs')
  } finally {
    await act(async () => root.unmount())
  }
})
