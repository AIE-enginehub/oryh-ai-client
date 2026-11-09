// @vitest-environment jsdom

import { useChatForms } from '@oryh/ai-client-kit'
import { fakeFace, wordsOf } from '@oryh/ai-client-kit/testing'
import type { CustomForm } from '@oryh/dsh-analytics/types'
import type { PaneFormContext } from '@oryh/dsh-pane/types'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { closedForms, FrameForm, type FrameFormReport, readFrameForms } from './frame-form.js'
import { words } from './words.js'

const t = wordsOf(words)

const order: CustomForm = {
  name: 'order',
  label: '补单',
  instruction: '按 oryh-order-submit 技能补一张销售订单。',
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
          defaults: { price: 'price' },
        },
        { name: 'quantity', label: '数量', type: 'number', required: true },
        { name: 'price', label: '单价', type: 'number', required: true },
      ],
    },
  ],
}
const data = { products: [{ id: 'p1', name: 'JC-800', price: '100' }] }
const blank = { product: '', quantity: '', price: '' }

describe('what a frame says of its forms', () => {
  it("is held to the page's declaration: its forms, their fields, each in its own kind", () => {
    expect(
      readFrameForms(
        [
          {
            name: 'order',
            row: 'rows.2',
            busy: true,
            values: { note: 7, urgent: 'yes', stray: 'x', items: [{ product: 'p1', extra: 1 }, 'x'] },
          },
          { name: 'order', row: 'rows.2', values: {} },
          { name: 'unknown', row: '', values: { note: 'x' } },
          { name: 'order', row: 5 },
        ],
        [order],
      ),
    ).toEqual([
      {
        id: 'order:rows.2',
        name: 'order',
        row: 'rows.2',
        busy: true,
        values: { note: '', urgent: false, items: [{ product: 'p1', quantity: '', price: '' }, blank] },
      },
    ])
    expect(readFrameForms('forms', [order])).toEqual([])
  })
})

describe('a framed form, for Chat', () => {
  it('describes the form, hands the frame what Chat fills, has it marked, and takes the fill back', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const pane = fakeFace()
    const described: PaneFormContext[][] = []
    const post = vi.fn()
    const node = document.createElement('div')
    const root = createRoot(node)
    // The page's owner: it collects the forms, and hands each the registry they describe themselves to.
    function Owner({ report }: { report: FrameFormReport }) {
      const registry = useChatForms(pane.face, {
        page: 'analytics',
        active: true,
        onForms: (forms: PaneFormContext[]) => described.push(forms),
      })
      return h(FrameForm, { face: pane.face, t, registry, report, form: order, data, post })
    }
    const render = (report: FrameFormReport) => act(async () => root.render(h(Owner, { report })))
    const start: FrameFormReport = {
      id: 'order:rows.2',
      name: 'order',
      row: 'rows.2',
      busy: false,
      values: { note: '老客户', urgent: false, items: [blank] },
    }
    await render(start)
    expect(described.at(-1)![0]).toMatchObject({
      id: 'order:rows.2',
      label: '补单',
      values: start.values,
      fields: [{ name: 'note' }, { name: 'urgent' }, { name: 'items', type: 'lines', max: 3 }],
    })
    post.mockClear()
    await act(async () =>
      pane.command({
        lane: 'form',
        id: 'c1',
        page: 'analytics',
        payload: {
          kind: 'fields',
          revision: 1,
          form: 'order:rows.2',
          base: { urgent: false, items: [blank] },
          values: { urgent: true, items: [{ product: 'p1', quantity: '2', price: '' }] },
        },
      }),
    )
    // Only what changed goes into the frame, with the price the choice brings along.
    const filled = { urgent: true, items: [{ product: 'p1', quantity: '2', price: '100' }] }
    expect(post).toHaveBeenCalledWith({ type: 'oryh-form-fill', form: 'order:rows.2', values: filled })
    expect(described.at(-1)![0]!.chat).toEqual({ id: 'c1', applied: ['urgent', 'items'], kept: [] })
    // The frame reports what it now holds: the fill stands, so it is marked and said.
    post.mockClear()
    await render({ ...start, values: { ...start.values, ...filled } })
    expect(post).toHaveBeenCalledWith({
      type: 'oryh-form-marks',
      form: 'order:rows.2',
      marks: ['urgent', 'items.0.product', 'items.0.quantity', 'items.0.price'],
    })
    expect(node.textContent).toContain('AI 助手填写了 4 处')
    expect(node.textContent).toContain('明细第 1 行 产品：空 → JC-800')
    expect(node.textContent).toContain('“补单”（第 3 行）尚未提交')
    post.mockClear()
    await act(async () => node.querySelector('button')!.click())
    expect(post).toHaveBeenCalledWith({
      type: 'oryh-form-fill',
      form: 'order:rows.2',
      values: { urgent: false, items: [blank] },
    })
    await act(async () => root.unmount())
  })
})

describe("a page's forms that are not on screen", () => {
  it('are the declared ones no open form belongs to, by what each is called', () => {
    const follow: CustomForm = { ...order, name: 'follow', label: '登记跟进' }
    // Every row has the form behind a button, and no row is open.
    expect(closedForms([follow], [])).toEqual(['登记跟进'])
    // One row's is open: the form is on the page, and Chat can reach it.
    expect(closedForms([follow], ['follow:rows.5'])).toEqual([])
    // A form outside any row is itself; another whose name only begins the same is not it.
    expect(closedForms([order, follow], ['order'])).toEqual(['登记跟进'])
    expect(closedForms([order], ['order_more:rows.1'])).toEqual(['补单'])
    expect(closedForms([], [])).toEqual([])
  })
})
