// @vitest-environment jsdom

import { useChatForms } from '@oryh/ai-client-kit'
import { fakeFace, wordsOf } from '@oryh/ai-client-kit/testing'
import type { CustomBlock, CustomForm } from '@oryh/dsh-analytics/types'
import type { PaneFormContext } from '@oryh/dsh-pane/types'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  fillMarkdown,
  formatValue,
  type HarnessActions,
  HarnessPage,
  rowWritten,
  type WrittenRecord,
} from './harness-page.js'
import { words } from './words.js'

const t = wordsOf(words)

// Harness's primitives stand in as plain elements: what is under test is how the page uses them.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant, size, icon, children, ...props }: any) => h('button', { type: 'button', ...props }, children),
  Pill: ({ active, children, ...props }: any) =>
    h('button', { type: 'button', 'aria-pressed': active, ...props }, children),
  Input: ({ icon, ...props }: any) => h('input', props),
  Checkbox: ({ checked, onChange, label }: any) =>
    h(
      'label',
      null,
      h('input', { type: 'checkbox', checked, onChange: (e: any) => onChange(e.target.checked) }),
      label,
    ),
  // Enough of Markdown to show a link: `[words](address)` becomes an anchor, as Harness draws one.
  MarkdownText: ({ text }: any) => {
    const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(text)
    if (!link) return h('div', { 'data-markdown': '' }, text)
    const [whole, words, href] = link
    const anchor = h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, words)
    return h('div', { 'data-markdown': '' }, text.slice(0, link.index), anchor, text.slice(link.index + whole.length))
  },
  SegmentedTabs: ({ items, value, onChange }: any) =>
    h(
      'div',
      { role: 'tablist' },
      items.map((item: any) =>
        h(
          'button',
          { key: item.value, role: 'tab', 'aria-selected': item.value === value, onClick: () => onChange(item.value) },
          item.label,
        ),
      ),
    ),
  DisclosureRow: ({ title, open, onToggle, children }: any) =>
    h('div', null, h('button', { type: 'button', 'aria-expanded': open, onClick: onToggle }, title), children),
}))

const rows = [
  { id: 'o1', customer: '泰安医院', amount: '1200.5', product: 'p1' },
  { id: 'o2', customer: '济南中心', amount: '300', product: 'p2' },
  { id: 'o3', customer: '泰安医院', amount: '4500', product: 'p1' },
  { id: 'o4', customer: '青岛一院', amount: '80', product: 'p2' },
  { id: 'o5', customer: '济南中心', amount: '999', product: 'p1' },
  { id: 'o6', customer: '烟台二院', amount: '15', product: 'p2' },
  { id: 'o7', customer: '潍坊人民', amount: '640', product: 'p1' },
]
const data = {
  headline: '九月订单',
  total: '7734.5',
  asOf: '2026-09-25T08:00:00Z',
  rows,
  products: [
    { id: 'p1', name: 'JC-900', price: '1200' },
    { id: 'p2', name: 'JC-100', price: '80' },
  ],
}
const follow: CustomForm = {
  name: 'follow',
  label: '补单',
  instruction: '为这一单补一张销售订单，按 oryh-order-submit 技能执行。',
  fields: [
    { name: 'note', label: '说明', type: 'text', required: true },
    { name: 'urgent', label: '加急', type: 'checkbox', required: false },
    {
      name: 'items',
      label: '明细',
      type: 'lines',
      required: true,
      min: 1,
      max: 3,
      fields: [
        {
          name: 'product',
          label: '产品',
          type: 'select',
          required: true,
          source: { data: 'products', value: 'id', label: 'name' },
          defaults: { unit_price: 'price' },
        },
        { name: 'quantity', label: '数量', type: 'number', required: true },
        { name: 'unit_price', label: '单价', type: 'number', required: true },
      ],
      computed: [{ name: 'amount', label: '金额', multiply: ['quantity', 'unit_price'] }],
    },
  ],
  computed: [{ name: 'sum', label: '合计', sum: 'items.amount' }],
}

function mount(blocks: CustomBlock[], forms: CustomForm[] = [], written: WrittenRecord[] = []) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const { face } = fakeFace()
  const actions = {
    open: vi.fn(),
    ask: vi.fn(),
    submit: vi.fn(async () => ({ ok: true, message: '已交给 Agent' })),
  } satisfies HarnessActions
  const render = () =>
    act(async () =>
      root.render(h(HarnessPage, { blocks, data, forms, fixedText: '口径：含税', actions, face, t, written })),
    )
  const button = (text: string) => [...node.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
  const click = (element: Element | undefined) =>
    act(async () => {
      ;(element as HTMLElement).click()
    })
  const type = (element: Element, value: string) =>
    act(async () => {
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
  const cells = () => [...node.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td')?.textContent)
  return { node, actions, render, button, click, type, cells, close: () => act(async () => root.unmount()) }
}

describe('a page drawn with Harness components', () => {
  it('writes values in as text, and loads no image', () => {
    expect(fillMarkdown('## {{headline}} 合计 {{total|money}} ![x](https://tracker.example/p.png)', data)).toBe(
      '## 九月订单 合计 7,734\\.50 x',
    )
    expect(fillMarkdown('{{headline}}', { headline: '**加粗** [链接](http://a)' })).toBe(
      '\\*\\*加粗\\*\\* \\[链接\\]\\(http://a\\)',
    )
    // An image by reference loads as surely as one written in place: its `![` is escaped, unless it was already.
    expect(fillMarkdown('![x][r] \\![y][r] \\\\![z][r]\n\n[r]: https://tracker.example/p.png?t={{total}}', data)).toBe(
      '\\![x][r] \\![y][r] \\\\\\![z][r]\n\n[r]: https://tracker.example/p.png?t=7734\\.5',
    )
    expect(formatValue('0.125', 'percent')).toBe('12.5%')
    expect(formatValue('2026-09-25T08:00:00Z', 'date')).toBe('2026-09-25')
  })

  it('shows markdown, metrics and the fixed text, and sorts and pages a table', async () => {
    const f = mount([
      { type: 'markdown', text: '## {{headline}}' },
      { type: 'metrics', items: [{ label: '合计', field: 'total', format: 'money' }] },
      {
        type: 'table',
        data: 'rows',
        columns: [
          { field: 'customer', label: '客户' },
          { field: 'amount', label: '金额', format: 'money' },
        ],
        pageSize: 5,
      },
      { type: 'fixed' },
    ])
    try {
      await f.render()
      expect(f.node.querySelector('[data-markdown]')?.textContent).toBe('## 九月订单')
      expect(f.node.querySelector('.harness-metric strong')?.textContent).toBe('7,734.50')
      expect(f.node.textContent).toContain('口径：含税')
      expect(f.cells()).toEqual(['泰安医院', '济南中心', '泰安医院', '青岛一院', '济南中心'])
      expect(f.node.textContent).toContain('1 / 2（共 7 条）')
      // Amounts sort as numbers, not as text: "80" is below "300".
      await f.click(f.button('金额'))
      expect(f.cells()).toEqual(['烟台二院', '青岛一院', '济南中心', '潍坊人民', '济南中心'])
      await f.click(f.button('金额 ↑'))
      expect(f.cells()[0]).toBe('泰安医院')
      await f.click(f.button('下一页'))
      expect(f.cells()).toEqual(['青岛一院', '烟台二院'])
    } finally {
      await f.close()
    }
  })

  it('shows a link in its Markdown as words that go nowhere', async () => {
    const f = mount([{ type: 'markdown', text: '详见[官网](https://example.com/?t={{total}})。' }, { type: 'fixed' }])
    try {
      await f.render()
      const link = f.node.querySelector('.harness-markdown a')!
      expect(link.textContent).toBe('官网')
      for (const type of ['click', 'auxclick']) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'click' ? 0 : 1 })
        await act(async () => {
          link.dispatchEvent(event)
        })
        expect(event.defaultPrevented).toBe(true)
      }
      // The fixed text is the model's Markdown as well.
      expect(f.node.querySelectorAll('.harness-markdown')).toHaveLength(2)
    } finally {
      await f.close()
    }
  })

  it('narrows tables, lists and charts by its filters, and names the row a command is about', async () => {
    const f = mount([
      { type: 'filter', targets: ['rows'], field: 'customer', label: '客户', control: 'pills' },
      { type: 'filter', targets: ['rows'], label: '搜索', control: 'text' },
      {
        type: 'table',
        data: 'rows',
        columns: [{ field: 'customer', label: '客户' }],
        sortable: false,
        open: 'sales_order:id',
        ask: [{ label: '看风险', question: '这一单有什么风险' }],
      },
      { type: 'chart', kind: 'bar', data: 'rows', label: 'customer', value: 'amount' },
      { type: 'list', data: 'rows', title: 'customer', meta: [{ field: 'amount', label: '金额', format: 'money' }] },
    ])
    try {
      await f.render()
      // Unfiltered, the chart has one bar per customer: 泰安医院's two orders are summed.
      expect(f.node.querySelectorAll('.harness-bar')).toHaveLength(5)
      expect(f.node.querySelector('.harness-bar strong')?.textContent).toBe('5,700.5')
      await f.click(f.button('泰安医院'))
      expect(f.cells()).toEqual(['泰安医院', '泰安医院'])
      expect(f.node.querySelectorAll('.harness-bar')).toHaveLength(1)
      expect(f.node.querySelectorAll('.harness-card')).toHaveLength(2)
      // The second 泰安医院 is the third row of the result: its path, not its place on screen.
      await f.click(f.node.querySelectorAll('tbody tr')[1]!.querySelector('button'))
      expect(f.actions.open).toHaveBeenCalledWith('rows.2', 'sales_order:id')
      await f.click(
        [...f.node.querySelectorAll('tbody tr')[1]!.querySelectorAll('button')].find(b => b.textContent === '看风险'),
      )
      expect(f.actions.ask).toHaveBeenCalledWith('rows.2', '这一单有什么风险')
      await f.click(f.button('全部'))
      await f.type(f.node.querySelector('.harness-filter input')!, '济南')
      expect(f.cells()).toEqual(['济南中心', '济南中心'])
    } finally {
      await f.close()
    }
  })

  it('lets every row be asked about, and points out the rows Chat just wrote', async () => {
    // A table written with no thought for Chat: no question of its own, nothing to open.
    const plain = mount([
      { type: 'table', data: 'rows', columns: [{ field: 'customer', label: '客户' }], sortable: false },
    ])
    try {
      await plain.render()
      await plain.click(plain.node.querySelectorAll('tbody tr')[2]!.querySelector('button'))
      expect(plain.actions.ask).toHaveBeenCalledWith('rows.2', words.harnessRowQuestion)
      expect(plain.node.querySelector('tr.chat-wrote')).toBeNull()
    } finally {
      await plain.close()
    }
    // A table that says what its rows are: the order Chat wrote is marked, and no other.
    const f = mount(
      [
        {
          type: 'table',
          data: 'rows',
          columns: [{ field: 'customer', label: '客户' }],
          sortable: false,
          open: 'sales_order:id',
        },
      ],
      [],
      [
        { collection: 'sales-orders', id: 'o4' },
        { collection: 'shipments', id: 'o1' },
      ],
    )
    try {
      await f.render()
      const marked = [...f.node.querySelectorAll('tr.chat-wrote')]
      expect(marked.map(tr => tr.querySelector('td')?.textContent)).toEqual(['青岛一院'])
      expect(marked[0]!.getAttribute('title')).toContain('AI 助手')
    } finally {
      await f.close()
    }
    expect(rowWritten('inventory_item:item_id', { item_id: 7 }, [{ collection: 'inventory-items', id: '7' }])).toBe(
      true,
    )
    expect(rowWritten(undefined, { id: 'o4' }, [{ collection: 'sales-orders', id: 'o4' }])).toBe(false)
  })

  it('switches tabs and folds a section', async () => {
    const f = mount([
      {
        type: 'tabs',
        tabs: [
          { label: '图表', blocks: [{ type: 'chart', kind: 'pie', data: 'rows', label: 'customer', value: 'amount' }] },
          { label: '说明', blocks: [{ type: 'markdown', text: '第二页' }] },
        ],
      },
      {
        type: 'section',
        title: '明细',
        collapsible: true,
        collapsed: true,
        blocks: [{ type: 'markdown', text: '折叠内容' }],
      },
    ])
    try {
      await f.render()
      expect(f.node.querySelector('.harness-pie')).not.toBeNull()
      expect(f.node.textContent).not.toContain('第二页')
      await f.click(f.button('说明'))
      expect(f.node.textContent).toContain('第二页')
      expect(f.node.querySelector('.harness-pie')).toBeNull()
      expect(f.node.textContent).not.toContain('折叠内容')
      await f.click(f.button('明细'))
      expect(f.node.textContent).toContain('折叠内容')
    } finally {
      await f.close()
    }
  })

  it('lays a row form out from its definition and hands its values over as a framed page does', async () => {
    const f = mount(
      [
        {
          type: 'table',
          data: 'rows',
          columns: [{ field: 'customer', label: '客户' }],
          sortable: false,
          form: 'follow',
        },
      ],
      [follow],
    )
    try {
      await f.render()
      // A row's form is offered by its own name.
      expect(f.node.querySelectorAll('tbody tr')[1]!.querySelector('button')?.textContent).toBe('补单')
      await f.click(f.node.querySelectorAll('tbody tr')[1]!.querySelector('button'))
      const form = f.node.querySelector('form.harness-form')!
      expect(form.getAttribute('aria-label')).toBe('补单')
      await f.type(form.querySelector('input[aria-label="说明"]')!, '客户要加急')
      // Choosing a product fills its price; the line's amount and the form's sum follow.
      await f.type(form.querySelector('select[aria-label="产品"]')!, 'p1')
      expect((form.querySelector('input[aria-label="单价"]') as HTMLInputElement).value).toBe('1200')
      await f.type(form.querySelector('input[aria-label="数量"]')!, '2')
      expect(form.querySelector('output[aria-label="金额"]')?.textContent).toBe('金额 2,400')
      await f.click([...form.querySelectorAll('button')].find(b => b.textContent === '加一行'))
      expect(form.querySelectorAll('.harness-line')).toHaveLength(2)
      expect(form.querySelector('output[aria-label="合计"]')?.textContent).toBe('合计 2,400')
      await f.click(form.querySelector('input[type=checkbox]'))
      await f.click([...form.querySelectorAll('button')].find(b => b.textContent === '补单'))
      expect(f.actions.submit).toHaveBeenCalledWith('follow', 'rows.1', {
        note: '客户要加急',
        urgent: true,
        items: [
          { product: 'p1', quantity: '2', unit_price: '1200' },
          { product: '', quantity: '', unit_price: '' },
        ],
      })
      expect(form.textContent).toContain('已交给 Agent')
      // Handed over, the form starts again.
      expect((form.querySelector('input[aria-label="说明"]') as HTMLInputElement).value).toBe('')
      expect(form.querySelectorAll('.harness-line')).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it('describes a form and its lines to Chat, takes a fill of them, and takes it back', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const pane = fakeFace()
    const reported: PaneFormContext[][] = []
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    const actions = { open: vi.fn(), ask: vi.fn(), submit: vi.fn(async () => ({ ok: true, message: '' })) }
    // The page's owner: it collects the forms, and hands the page the registry they describe themselves to.
    function Owner() {
      const registry = useChatForms(pane.face, {
        page: 'analytics',
        active: true,
        onForms: (forms: PaneFormContext[]) => reported.push(forms),
      })
      return h(HarnessPage, {
        blocks: [{ type: 'form', name: 'follow' }],
        data,
        forms: [follow],
        fixedText: '',
        actions,
        face: pane.face,
        t,
        registry,
      })
    }
    await act(async () => root.render(h(Owner)))
    const form = () => reported.at(-1)![0]!
    const blankLine = { product: '', quantity: '', unit_price: '' }
    expect(form().fields.find(field => field.name === 'items')).toMatchObject({
      type: 'lines',
      min: 1,
      max: 3,
      columns: [
        {
          name: 'product',
          type: 'select',
          options: [
            { value: 'p1', label: 'JC-900' },
            { value: 'p2', label: 'JC-100' },
          ],
        },
        { name: 'quantity', type: 'number' },
        { name: 'unit_price', type: 'number' },
      ],
    })
    expect(form().values).toEqual({ note: '', urgent: false, items: [blankLine] })
    await act(async () =>
      pane.command({
        lane: 'form',
        id: 'c1',
        page: 'analytics',
        payload: {
          kind: 'fields',
          revision: 1,
          form: 'follow',
          base: { note: '', items: [blankLine] },
          values: {
            note: '补两台',
            items: [
              { product: 'p1', quantity: '2', unit_price: '' },
              { product: 'p2', quantity: '1', unit_price: '75' },
            ],
          },
        },
      }),
    )
    expect(pane.acked()).toEqual(['c1'])
    expect(form().chat).toEqual({ id: 'c1', applied: ['note', 'items'], kept: [] })
    // The choice brings its price where the agent left it empty, as it does when a person picks it.
    expect(form().values.items).toEqual([
      { product: 'p1', quantity: '2', unit_price: '1200' },
      { product: 'p2', quantity: '1', unit_price: '75' },
    ])
    // The note, each column of the first row that changed, and the whole of the row that was added.
    expect(node.querySelectorAll('[data-ai-filled]')).toHaveLength(7)
    expect(node.textContent).toContain('明细第 1 行 产品：空 → JC-900')
    expect(node.textContent).toContain('明细第 2 行：新增')
    await act(async () => {
      ;[...node.querySelectorAll('button')].find(button => button.textContent === '撤销这次填写')!.click()
    })
    expect(form().values).toEqual({ note: '', urgent: false, items: [blankLine] })
    expect(node.querySelectorAll('[data-ai-filled]')).toHaveLength(0)
    await act(async () => root.unmount())
    node.remove()
  })
})
