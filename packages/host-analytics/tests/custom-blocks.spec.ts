import { describe, expect, it } from 'vitest'
import { blockIssues, blockQuestions, type CustomBlock } from '../src/custom-blocks.js'
import { customDefinitionSchema, declaredQuestions } from '../src/custom-model.js'

const task = {
  instruction: '统计当前销售订单，按客户汇总金额，不得编造事实。',
  timeZone: 'Asia/Shanghai',
  contract: {
    fields: [
      { name: 'headline', type: 'string', required: true },
      { name: 'total', type: 'string', required: true },
      { name: 'count', type: 'number', required: true },
      { name: 'meta', type: 'object', required: false, fields: [{ name: 'note', type: 'string', required: true }] },
      {
        name: 'rows',
        type: 'array',
        required: true,
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'customer', type: 'string', required: true },
          { name: 'amount', type: 'string', required: true },
        ],
      },
    ],
  },
}
const form = {
  name: 'follow',
  label: '跟进',
  instruction: '为这一单建一条跟进待办，写明客户和金额，按 oryh-todo 技能执行。',
  fields: [{ name: 'note', label: '说明', type: 'text', required: true }],
}
const blocks: CustomBlock[] = [
  { type: 'markdown', text: '## {{headline}}\n合计 {{total|money}}，共 {{count}} 单' },
  { type: 'metrics', items: [{ label: '合计', field: 'total', format: 'money' }] },
  { type: 'filter', targets: ['rows'], field: 'customer', label: '客户', control: 'pills' },
  {
    type: 'tabs',
    tabs: [
      { label: '图表', blocks: [{ type: 'chart', kind: 'bar', data: 'rows', label: 'customer', value: 'amount' }] },
      {
        label: '明细',
        blocks: [
          {
            type: 'section',
            title: '订单',
            collapsible: true,
            blocks: [
              {
                type: 'table',
                data: 'rows',
                columns: [
                  { field: 'customer', label: '客户' },
                  { field: 'amount', label: '金额', format: 'money' },
                ],
                open: 'sales_order:id',
                ask: [{ label: '看风险', question: '这一单有什么风险' }],
                form: 'follow',
              },
            ],
          },
        ],
      },
    ],
  },
  { type: 'fixed' },
]
const harness = { title: '订单统计', mode: 'harness', blocks, fixedText: '口径说明', task, forms: [form] }

describe('a page drawn with Harness components', () => {
  it('saves blocks that bind the data contract, with the HTML parts left out', () => {
    const definition = customDefinitionSchema.parse(harness)
    expect(definition).toMatchObject({ mode: 'harness', script: '', blocks })
    expect(definition.html).toBeUndefined()
    // The rows' questions are what an ask from the page is held to.
    expect(declaredQuestions(definition)).toEqual(['这一单有什么风险'])
  })

  it('names the block and the binding that the contract does not have', () => {
    const issues = blockIssues(
      [
        { type: 'markdown', text: '{{nothing}} {{rows}} {{total|euro}}' },
        { type: 'metrics', items: [{ label: '备注', field: 'meta' }] },
        { type: 'table', data: 'total', columns: [{ field: 'customer', label: '客户' }] },
        {
          type: 'tabs',
          tabs: [
            { label: '一', blocks: [{ type: 'chart', kind: 'pie', data: 'rows', label: 'customer', value: 'price' }] },
            { label: '二', blocks: [{ type: 'list', data: 'rows', title: 'customer', open: 'sales_order:order' }] },
          ],
        },
        { type: 'filter', targets: ['rows', 'orders'], field: 'customer', label: '客户', control: 'text' },
        { type: 'form', name: 'missing' },
        { type: 'filter', targets: ['rows'], label: '客户', control: 'pills' },
      ],
      task.contract.fields as never,
      [form],
    )
    expect(issues).toEqual([
      'blocks[0]（markdown）：{{nothing}}：nothing 不在数据约定里',
      'blocks[0]（markdown）：{{rows}}：rows 是 array，这里只能放单个值',
      'blocks[0]（markdown）：{{total|euro}}：格式只能是 number、money、percent、date',
      'blocks[1]（metrics）：meta 是 object，这里只能放单个值',
      'blocks[2]（table）：data=total 不是数据约定里列出了字段的对象数组',
      'blocks[3]（tabs）.tabs[0].blocks[0]（chart）：字段 price 不是 rows 每一项的字段',
      'blocks[3]（tabs）.tabs[1].blocks[0]（list）：open 的字段 order 不是 rows 每一项的字段',
      'blocks[4]（filter）：data=orders 不在数据约定里',
      'blocks[5]（form）：missing 不在 definition.forms 里',
      'blocks[6]（filter）：control=pills 要写 field',
    ])
  })

  it('keeps the two ways apart, and reads a page saved before there was a choice as HTML', () => {
    expect(() => customDefinitionSchema.parse({ ...harness, html: '<main></main>' })).toThrow('不能带 html、css')
    expect(() => customDefinitionSchema.parse({ ...harness, blocks: undefined })).toThrow('要有 blocks')
    const html = { title: '旧页面', html: '<main></main>', css: '', script: '', fixedText: '', task, forms: [] }
    expect(customDefinitionSchema.parse(html).mode).toBe('html')
    expect(() => customDefinitionSchema.parse({ ...html, blocks })).toThrow('不能带 blocks')
    expect(() => customDefinitionSchema.parse({ ...html, mode: 'html', html: undefined })).toThrow('要有 html')
  })

  it('draws a page that does not say how with Harness components', () => {
    const { mode: _mode, ...unsaid } = harness
    expect(customDefinitionSchema.parse(unsaid).mode).toBe('harness')
    // With neither markup nor blocks it is still a Harness page, and is told what one needs.
    expect(() => customDefinitionSchema.parse({ ...unsaid, blocks: undefined })).toThrow('要有 blocks')
  })

  it('holds nesting and size to what the page can draw', () => {
    const deep: CustomBlock = {
      type: 'section',
      title: '一',
      blocks: [
        { type: 'section', title: '二', blocks: [{ type: 'section', title: '三', blocks: [{ type: 'fixed' }] }] },
      ],
    }
    expect(blockIssues([deep], task.contract.fields as never, [])).toEqual([
      'blocks[0]（section）.blocks[0]（section）.blocks[0]（section）.blocks：积木最多嵌套 3 层',
    ])
    const many = Array.from({ length: 41 }, () => ({ type: 'fixed' as const }))
    expect(
      blockIssues(
        [
          { type: 'section', title: 'a', blocks: many.slice(0, 40) },
          { type: 'section', title: 'b', blocks: many.slice(0, 40) },
        ],
        task.contract.fields as never,
        [],
      ),
    ).toEqual(['积木一共 82 块，最多 80 块'])
    expect(blockQuestions([deep])).toEqual([])
  })
})
