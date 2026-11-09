import { describe, expect, it } from 'vitest'
import { type CustomForm, customFormSchema, formIssues, prepareSubmission } from '../src/custom-forms.js'
import type { ContractField } from '../src/custom-model.js'

const contract: ContractField[] = [
  {
    name: 'products',
    type: 'array',
    required: true,
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'price', type: 'string', required: true },
    ],
  },
  { name: 'rows', type: 'array', required: true },
]

const order = (changes: Partial<CustomForm> = {}): CustomForm =>
  customFormSchema.parse({
    name: 'createOrder',
    label: '创建订单',
    instruction: '为所选客户创建一张销售订单，按 oryh-order-submit 执行。',
    fields: [
      { name: 'currency', label: '币种', type: 'select', required: true, options: ['CNY', 'USD'] },
      { name: 'agree', label: '已核对库存', type: 'checkbox', required: true },
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
          { name: 'gift', label: '赠品', type: 'checkbox', required: false },
        ],
        computed: [{ name: 'amount', label: '金额', multiply: ['quantity', 'price'], zeroWhen: 'gift' }],
      },
    ],
    computed: [{ name: 'total', label: '合计', sum: 'items.amount' }],
    ...changes,
  })

const data = {
  products: [
    { id: 'p1', name: 'JC-800', price: '121600' },
    { id: 'p2', name: '色带', price: '335' },
  ],
}

describe('custom page forms', () => {
  it('saves a form whose options, defaults and figures all point at something real', () => {
    expect(formIssues([order()], contract)).toEqual([])
    const [items] = order().fields.filter(field => field.type === 'lines')
    const issues = (form: CustomForm) => formIssues([form], contract).join('\n')
    // A select needs exactly one of fixed options or options from the result, and that array must be declared.
    expect(issues(order({ fields: [{ name: 'x', label: 'x', type: 'select', required: true }] }))).toContain('二选一')
    expect(
      issues(
        order({
          fields: [
            {
              name: 'x',
              label: 'x',
              type: 'select',
              required: true,
              source: { data: 'customers', value: 'id', label: 'name' },
            },
          ],
        }),
      ),
    ).toContain('数组 customers')
    expect(
      issues(
        order({
          fields: [
            {
              name: 'x',
              label: 'x',
              type: 'select',
              required: true,
              source: { data: 'rows', value: 'id', label: 'name' },
            },
          ],
        }),
      ),
    ).toContain('数组 rows')
    // Defaults only fill a sibling of a lines' select, from a field the option has.
    expect(
      issues(
        order({
          fields: [
            {
              name: 'x',
              label: 'x',
              type: 'select',
              required: true,
              source: { data: 'products', value: 'id', label: 'name' },
              defaults: { y: 'price' },
            },
          ],
        }),
      ),
    ).toContain('defaults 只用于明细行')
    // Figures multiply numbers of the line, and a form's sums name a real column.
    expect(
      issues(
        order({
          fields: [{ ...items!, computed: [{ name: 'amount', label: '金额', multiply: ['product', 'quantity'] }] }],
        }),
      ),
    ).toContain('product 不是这一行的数字字段')
    expect(issues(order({ computed: [{ name: 'total', label: '合计', sum: 'items.weight' }] }))).toContain(
      'items.weight',
    )
    expect(issues(order({ computed: [{ name: 'currency', label: '合计', sum: 'items.amount' }] }))).toContain(
      '与字段同名',
    )
    expect(() => order({ fields: [{ ...items!, max: 51 }] })).toThrow()
  })
  it('holds a submission to its form: blank lines dropped, figures exact, choices from the result', () => {
    const lines = [
      { product: 'p1', quantity: '2', price: '121600', gift: false },
      { product: '', quantity: '', price: '', gift: false },
      { product: 'p2', quantity: '10', price: '335', gift: true },
    ]
    const prepared = prepareSubmission(order(), { currency: 'CNY', agree: true, items: lines }, data, '')
    expect(prepared.entries).toEqual([
      { label: '币种', value: 'CNY' },
      { label: '已核对库存', value: '是' },
    ])
    expect(prepared.lines[0]!.rows).toEqual([
      ['JC-800', '2', '121600', '否', '243200'],
      ['色带', '10', '335', '是', '0'],
    ])
    expect(prepared.computed).toEqual([{ label: '合计', value: '243200' }])
    expect(prepared.values.items).toEqual([
      { product: { value: 'p1', label: 'JC-800' }, quantity: '2', price: '121600', gift: false },
      { product: { value: 'p2', label: '色带' }, quantity: '10', price: '335', gift: true },
    ])
    // The same content gives the same digest; any change gives another.
    expect(prepareSubmission(order(), { currency: 'CNY', agree: true, items: lines }, data, '').digest).toBe(
      prepared.digest,
    )
    expect(prepareSubmission(order(), { currency: 'USD', agree: true, items: lines }, data, '').digest).not.toBe(
      prepared.digest,
    )
  })
  it('refuses what a person could not have meant to send', () => {
    const line = { product: 'p1', quantity: '1', price: '1' }
    const submit = (values: Record<string, unknown>) => () =>
      prepareSubmission(order(), { currency: 'CNY', agree: true, items: [line], ...values }, data, '')
    expect(submit({ agree: false })).toThrow('请勾选“已核对库存”')
    expect(submit({ items: [] })).toThrow('至少要填 1 行')
    expect(submit({ items: [line, line, line, line] })).toThrow('最多 3 行')
    expect(submit({ items: [{ ...line, quantity: '一' }] })).toThrow('第 1 行：“数量”须是数字')
    expect(submit({ items: [{ ...line, product: 'p9' }] })).toThrow('不在页面数据里')
    expect(submit({ items: [{ ...line, discount: '9' }] })).toThrow('没有字段 discount')
    expect(submit({ currency: 'EUR' })).toThrow('选项无效')
    expect(submit({ items: 'all' })).toThrow('须是明细列表')
    expect(submit({ note: 'x'.repeat(70_000) })).toThrow('64 KB')
  })
})
