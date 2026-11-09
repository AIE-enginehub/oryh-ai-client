import { describe, expect, it } from 'vitest'
import { fieldValue, installFormTools } from '../src/forms.js'
import { PaneService } from '../src/service.js'
import {
  connectionId,
  fakeConnection,
  fakeContext,
  fakeController,
  paneSyncer,
  tempDirectory,
  until,
} from '../src/testing.js'
import type { PaneContext, PaneFormContext } from '../src/types.js'
import { UserViewRegistry } from '../src/user-views.js'

/** A form a custom page might show: reschedule a delivery, with a reason and a carrier to pick. */
const reschedule: PaneFormContext = {
  id: 'reschedule:rows.3',
  label: '改期',
  fields: [
    { name: 'new_date', label: '新日期', type: 'date', required: true },
    { name: 'reason', label: '原因', type: 'textarea' },
    {
      name: 'carrier',
      label: '承运商',
      type: 'select',
      options: [
        { value: 'dp', label: '德邦' },
        { value: 'sf', label: '顺丰' },
      ],
    },
    { name: 'urgent', label: '加急', type: 'checkbox' },
    { name: 'boxes', label: '箱数', type: 'number' },
  ],
  values: { new_date: '', reason: '', carrier: '', urgent: false, boxes: '' },
  busy: false,
}
/** The same form with a code of at most eight letters and the goods to send, one row each. */
const withLines: PaneFormContext = {
  ...reschedule,
  fields: [
    ...reschedule.fields,
    { name: 'code', label: '编码', type: 'text', maxLength: 8 },
    {
      name: 'items',
      label: '货品',
      type: 'lines',
      min: 1,
      max: 3,
      columns: [
        {
          name: 'product',
          label: '产品',
          type: 'select',
          options: [
            { value: 'p1', label: 'JC-900' },
            { value: 'p2', label: 'JC-100' },
          ],
        },
        { name: 'qty', label: '数量', type: 'number' },
        { name: 'gift', label: '赠品', type: 'checkbox' },
      ],
    },
  ],
  values: { ...reschedule.values, code: '', items: [] },
}
const page = (forms: PaneFormContext[]): PaneContext => ({
  key: 'custom:p1',
  title: '发货跟进',
  detail: '',
  scope: '',
  forms,
})

async function setup() {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const { controller } = fakeController(fakeConnection(), 1)
  const pane = new PaneService(harness.ctx, controller, temp.directory, new UserViewRegistry(harness.ctx))
  installFormTools(harness.ctx, pane)
  await pane.bind({ sessionId: 's', connectionId })
  const exec = { agent: { id: 's' }, callId: 'call-1', signal: new AbortController().signal }
  const fill = (args: Record<string, unknown>) => harness.tool('oryh_form_fill').execute(args, exec)
  return { ...harness, pane, sync: paneSyncer(pane), fill, close: temp.close }
}

describe('filling a form a page describes', () => {
  it('holds a value to its field: a choice the form offers, a date as a date, a tick as a tick', () => {
    expect(fieldValue(reschedule, 'reason', '客户要求')).toBe('客户要求')
    expect(fieldValue(reschedule, 'carrier', 'sf')).toBe('sf')
    expect(fieldValue(reschedule, 'carrier', '')).toBe('')
    expect(fieldValue(reschedule, 'urgent', true)).toBe(true)
    expect(fieldValue(reschedule, 'boxes', 12)).toBe('12')
    expect(fieldValue(reschedule, 'boxes', '1,200')).toBe('1,200')
    for (const [name, value] of [
      ['carrier', '中通'],
      ['new_date', '10月12日'],
      ['urgent', 'yes'],
      ['boxes', '很多'],
      ['reason', { text: 'x' }],
      ['nonsense', 'x'],
      // A day the calendar does not have, and text past the field's own limit.
      ['new_date', '2026-02-30'],
      ['code', 'A'.repeat(9)],
    ] as const)
      expect(fieldValue(withLines, name, value)).toMatchObject({ problem: expect.any(String) })
    expect(fieldValue(withLines, 'code', 'A'.repeat(8))).toBe('A'.repeat(8))
  })

  it('holds lines to their columns: every row whole, an unnamed column empty, and no more rows than the form takes', () => {
    expect(
      fieldValue(withLines, 'items', [
        { product: 'p1', qty: 2 },
        { product: 'p2', gift: true },
      ]),
    ).toEqual([
      { product: 'p1', qty: '2', gift: false },
      { product: 'p2', qty: '', gift: true },
    ])
    expect(fieldValue(withLines, 'items', [])).toMatchObject({ problem: expect.stringMatching(/至少 1 行/) })
    for (const value of [
      'p1',
      [{ product: 'p9' }],
      [{ product: 'p1', price: '3' }],
      [{ product: 'p1', gift: 'yes' }],
      ['p1'],
      [{ product: 'p1' }, { product: 'p1' }, { product: 'p1' }, { product: 'p1' }],
    ])
      expect(fieldValue(withLines, 'items', value)).toMatchObject({ problem: expect.any(String) })
    expect(fieldValue(withLines, 'items', [{ product: 'p1', qty: '多' }])).toMatchObject({
      problem: expect.stringMatching(/第 1 行：数量（qty）要填数字/),
    })
  })

  it("stages lines against the rows the form held, and refuses a fill the page's own rules object to", async () => {
    const f = await setup()
    try {
      const before = { ...withLines.values, items: [{ product: '', qty: '', gift: false }] }
      f.sync.sync('analytics', page([{ ...withLines, values: before }]))
      const release = f.pane.contribute({
        name: 'rules',
        checkForm: (_page, form, values) =>
          form.id === withLines.id && values.new_date === '2026-10-01' ? '新日期不能早于今天。' : undefined,
      })
      await expect(f.fill({ values: { new_date: '2026-10-01' } })).rejects.toThrow(/没有填写：新日期不能早于今天/)
      expect(f.pane.queue.peek('s', 'form')).toBeUndefined()
      release()
      const filling = f.fill({ values: { items: [{ product: 'p1', qty: '2' }] } })
      await until(() => f.pane.queue.peek('s', 'form') !== undefined)
      const command = f.pane.queue.peek('s', 'form')!
      expect(command.payload).toMatchObject({
        base: { items: [{ product: '', qty: '', gift: false }] },
        values: { items: [{ product: 'p1', qty: '2', gift: false }] },
      })
      const after = { ...before, items: [{ product: 'p1', qty: '2', gift: false }] }
      f.sync.ack(
        'form',
        'analytics',
        page([{ ...withLines, values: after, chat: { id: command.id, applied: ['items'], kept: [] } }]),
      )
      expect(JSON.parse(await filling)).toMatchObject({ applied: ['items'], values: { items: after.items } })
    } finally {
      await f.close()
    }
  })

  it('stages the fields against what the form held, and reports which the page took and which it kept', async () => {
    const f = await setup()
    try {
      f.sync.sync('analytics', page([reschedule]))
      const filling = f.fill({ values: { new_date: '2026-10-12', reason: '客户要求改期', urgent: true } })
      await until(() => f.pane.queue.peek('s', 'form') !== undefined)
      const command = f.pane.queue.peek('s', 'form')!
      expect(command.payload).toEqual({
        kind: 'fields',
        revision: 1,
        form: 'reschedule:rows.3',
        base: { new_date: '', reason: '', urgent: false },
        values: { new_date: '2026-10-12', reason: '客户要求改期', urgent: true },
      })
      // The person had typed a reason in the meantime: the page keeps it, fills the rest, and says so.
      const after = { ...reschedule.values, new_date: '2026-10-12', reason: '我自己写的', urgent: true }
      f.sync.ack(
        'form',
        'analytics',
        page([
          { ...reschedule, values: after, chat: { id: command.id, applied: ['new_date', 'urgent'], kept: ['reason'] } },
        ]),
      )
      const result = JSON.parse(await filling)
      expect(result).toMatchObject({ form: 'reschedule:rows.3', applied: ['new_date', 'urgent'], kept: ['reason'] })
      expect(result.values.reason).toBe('我自己写的')
      expect(result.notice).toMatch(/保留/)
      expect(result.notice).toMatch(/还没有保存或提交/)
    } finally {
      await f.close()
    }
  })

  it('refuses what the form does not have, and asks which form when the page shows several', async () => {
    const f = await setup()
    try {
      f.sync.sync('my-open-todos', { key: 'my-open-todos:list', title: '我的待办', detail: '', scope: '' })
      await expect(f.fill({ values: { reason: 'x' } })).rejects.toThrow(/没有可以代填的表单/)
      // A page whose forms are behind its rows' buttons has forms, and none on screen. That is not a page
      // that cannot be filled: the agent is told to have the row opened, where it used to say it could not.
      f.sync.sync('analytics', { ...page([]), closedForms: ['改期'] })
      await expect(f.fill({ values: { reason: 'x' } })).rejects.toThrow(/有表单（改期）.*先在页面上点开要填的那一行/)
      f.sync.sync('analytics', page([reschedule, { ...reschedule, id: 'cancel', label: '取消发货' }]))
      await expect(f.fill({ values: { reason: 'x' } })).rejects.toThrow(
        /reschedule:rows\.3（改期）、cancel（取消发货）/,
      )
      await expect(f.fill({ form: 'cancel', values: { carrier: '中通', when: 'x' } })).rejects.toThrow(
        /承运商（carrier）只能是.*没有字段 when/,
      )
      await expect(f.fill({ form: 'cancel', values: {} })).rejects.toThrow(/没有要填写的字段/)
      f.sync.sync('analytics', page([{ ...reschedule, busy: true }]))
      await expect(f.fill({ values: { reason: 'x' } })).rejects.toThrow(/正在提交/)
      expect(f.pane.queue.peek('s', 'form')).toBeUndefined()
    } finally {
      await f.close()
    }
  })
})
