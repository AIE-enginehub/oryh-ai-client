import { describe, expect, it } from 'vitest'
import {
  chatFormMessage,
  chosenRecords,
  lookupKey,
  parseChatForm,
  prepareChatForm,
  withRecords,
} from '../src/chat-form.js'

const order = {
  form: {
    name: 'order',
    label: '录入销售订单',
    instruction: '按 oryh-order-submit 技能创建一张销售订单，创建后不提交审批。',
    fields: [
      {
        name: 'store',
        label: '店铺',
        type: 'select',
        required: true,
        source: { data: 'stores', value: 'id', label: 'name' },
      },
      { name: 'order_date', label: '订单日期', type: 'date', required: true },
      {
        name: 'items',
        label: '商品明细',
        type: 'lines',
        required: true,
        min: 1,
        max: 20,
        fields: [
          { name: 'product', label: '产品', type: 'text', required: true },
          { name: 'quantity', label: '数量', type: 'number', required: true },
          { name: 'unit_price', label: '单价', type: 'number', required: false },
        ],
        computed: [{ name: 'amount', label: '金额', multiply: ['quantity', 'unit_price'] }],
      },
    ],
    computed: [{ name: 'total', label: '合计', sum: 'items.amount' }],
  },
  data: { stores: [{ id: 's-1', name: '国内线下' }] },
  values: { order_date: '2026-10-09' },
}

describe('a form in the conversation', () => {
  it('is held to what a form may be, with the choices its selects draw on', () => {
    const shown = parseChatForm(order)
    expect(shown.form.label).toBe('录入销售订单')
    expect(shown.values).toEqual({ order_date: '2026-10-09' })
    // A select has to have choices the form was given: the agent reads them from ORYH first.
    expect(() => parseChatForm({ ...order, data: {} })).toThrow('data 里没有它')
    expect(() => parseChatForm({ ...order, data: { stores: [{ id: 's-1' }] } })).toThrow('都要有字段 name')
    expect(() => parseChatForm({ ...order, values: { nope: 1 } })).toThrow('不是表单的字段')
    expect(() => parseChatForm({ ...order, extra: true })).toThrow('表单定义无效')
    expect(() => parseChatForm({ form: { ...order.form, fields: [] } })).toThrow('表单定义无效')
    const big = {
      ...order,
      data: { stores: Array.from({ length: 200 }, (_, n) => ({ id: `s-${n}`, name: 'x'.repeat(400) })) },
    }
    expect(() => parseChatForm(big)).toThrow('64 KB')
  })

  it("goes on as the person's own message: what they filled in, then what is to be done with it", () => {
    const { label, message } = prepareChatForm('call-1', {
      shown: parseChatForm(order),
      values: {
        store: 's-1',
        order_date: '2026-10-09',
        items: [
          { product: '登山杖', quantity: '2', unit_price: '100' },
          { product: '护膝', quantity: '3', unit_price: '50' },
          // A line added and left empty is not sent.
          { product: '', quantity: '', unit_price: '' },
        ],
      },
    })
    expect(label).toBe('录入销售订单')
    // The line a browser reads back to know this form was submitted.
    expect(message.split('\n')[0]).toBe('我填好了「录入销售订单」（表单编号 call-1）。')
    expect(message).toContain('- 店铺：国内线下')
    expect(message).toContain('| 登山杖 | 2 | 100 | 200 |')
    expect(message).toContain('合计 350')
    // Nothing is written yet: the agent is told to say what it will write and ask first.
    expect(message).toContain('还没有写入 ORYH')
    expect(message).toContain('按 oryh-order-submit 技能创建一张销售订单')
    expect(message).toContain('"store":{"value":"s-1","label":"国内线下"}')
  })

  it('composes an English submission without Chinese boilerplate', () => {
    const message = chatFormMessage(
      'english-call',
      {
        label: 'Quotation entry',
        instruction: 'Review this draft, then ask before saving.',
        entries: [{ label: 'Customer', value: 'Atlas' }],
        lines: [{ label: 'Lines', columns: ['Product', 'Quantity'], rows: [['DAQ', '2']] }],
        computed: [{ label: 'Total USD', value: '2400' }],
        values: {},
        digest: '',
      },
      'en-US',
    )
    expect(message).toContain('I completed "Quotation entry" (Form ID english-call).')
    expect(message).toContain('Nothing has been written to ORYH.')
    expect(message).toContain('Before writing, list the exact proposed facts and ask for confirmation.')
    expect(message).toContain('Total USD 2400')
    expect(message).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('refuses values the form does not take, in words for the person', () => {
    const values = { store: 's-1', order_date: '2026-10-09', items: [{ product: '登山杖', quantity: '2' }] }
    expect(() =>
      prepareChatForm('call-1', { shown: parseChatForm(order), values: { ...values, store: 's-9' } }),
    ).toThrow('店铺')
    expect(() => prepareChatForm('call-1', { shown: parseChatForm(order), values: { ...values, items: [] } })).toThrow(
      '商品明细',
    )
    expect(() => prepareChatForm('call-1', { shown: parseChatForm(order), values: { ...values, other: 'x' } })).toThrow(
      '没有字段 other',
    )
    expect(() => prepareChatForm('bad id!', { shown: parseChatForm(order), values })).toThrow('表单编号无效')
    expect(
      chatFormMessage('c', {
        label: 'L',
        instruction: 'I',
        entries: [],
        lines: [],
        computed: [],
        values: {},
        digest: '',
      }),
    ).toContain('我填好了「L」（表单编号 c）。')
  })

  it('holds a chosen record to one ORYH has, by the id the person picked, whatever the collection', () => {
    const customers = { collection: 'customers', label: 'name', code: 'customer_code' }
    const entry = {
      form: {
        name: 'order',
        label: '录入销售订单',
        instruction: '按 oryh-order-submit 技能创建一张销售订单。',
        fields: [
          { name: 'customer', label: '客户', type: 'record', required: true, lookup: customers },
          {
            name: 'items',
            label: '商品明细',
            type: 'lines',
            required: true,
            min: 1,
            max: 20,
            fields: [
              // The name the first forms used for a product; still a record of the catalogue.
              { name: 'product', label: '产品', type: 'product', required: true },
              { name: 'quantity', label: '数量', type: 'number', required: true },
            ],
          },
        ],
      },
    }
    const shown = parseChatForm(entry)
    const values = {
      customer: 'c-1',
      items: [
        { product: 'p-1', quantity: '2' },
        { product: 'p-2', quantity: '1' },
        { product: 'p-1', quantity: '5' },
      ],
    }
    const chosen = chosenRecords(shown.form, values)
    expect(chosen.map(entry => [entry.lookup.collection, entry.ids])).toEqual([
      ['customers', ['c-1']],
      ['products', ['p-1', 'p-2']],
    ])
    const products = chosen[1]!.lookup
    const found = new Map([
      [lookupKey(customers), [{ id: 'c-1', name: '仁济医院', code: 'H-001' }]],
      [
        lookupKey(products),
        [
          { id: 'p-1', name: '登山杖', code: 'DSZ-01' },
          { id: 'p-2', name: '护膝', code: '' },
        ],
      ],
    ])
    const { message } = prepareChatForm('call-2', { shown: withRecords(shown, found), values })
    expect(message).toContain('- 客户：仁济医院（H-001）')
    expect(message).toContain('| 登山杖（DSZ-01） | 2 |')
    expect(message).toContain('"customer":{"value":"c-1","label":"仁济医院（H-001）"}')
    expect(message).toContain('"product":{"value":"p-2","label":"护膝"}')
    // An id ORYH did not answer for is not a record: nothing made up in a browser goes on.
    const missing = new Map([
      [lookupKey(customers), []],
      [lookupKey(products), found.get(lookupKey(products))!],
    ])
    expect(() => prepareChatForm('call-2', { shown: withRecords(shown, missing), values })).toThrow('客户')
  })

  it('refuses a reference the person would have to type', () => {
    const form = (field: object) => ({
      form: { name: 'f', label: '表单', instruction: '按技能创建一张单据并回读。', fields: [field] },
    })
    // A field that holds another record's id is a choice, never a text box.
    for (const name of ['customer_id', 'warehouseId', 'id'])
      expect(() => parseChatForm(form({ name, label: '客户', type: 'text', required: true }))).toThrow('不能让用户手填')
    expect(() => parseChatForm(form({ name: 'project_id', label: '项目', type: 'number', required: false }))).toThrow(
      '不能让用户手填',
    )
    // Nor is its name asked for in its place: that is the same reference, typed.
    for (const name of ['customer_name', 'supplierName', 'product_code', 'warehouse_name', 'quote_no'])
      expect(() => parseChatForm(form({ name, label: '客户名称', type: 'text', required: false }))).toThrow(
        '不能让用户手填',
      )
    for (const name of ['contact_name', 'ship_to_address', 'title', 'name', 'buyer_nickname'])
      expect(parseChatForm(form({ name, label: '联系人', type: 'text', required: false })).form.fields).toHaveLength(1)
    // Chosen, the same field is fine; so is free text that only sounds like one.
    const lookup = { collection: 'customers', label: 'name' }
    expect(
      parseChatForm(form({ name: 'customer_id', label: '客户', type: 'record', required: true, lookup })).form.fields,
    ).toHaveLength(1)
    expect(
      parseChatForm(form({ name: 'paid', label: '已付', type: 'text', required: false })).form.fields,
    ).toHaveLength(1)
    expect(
      parseChatForm(form({ name: 'platform_order_no', label: '平台单号', type: 'text', required: false })).form.fields,
    ).toHaveLength(1)
    // A record field says where it looks, and only a record field does.
    expect(() => parseChatForm(form({ name: 'customer', label: '客户', type: 'record', required: true }))).toThrow(
      '须给 lookup',
    )
    expect(() =>
      parseChatForm(form({ name: 'customer', label: '客户', type: 'text', required: true, lookup })),
    ).toThrow('只有 record 字段可以有 lookup')
  })
})
