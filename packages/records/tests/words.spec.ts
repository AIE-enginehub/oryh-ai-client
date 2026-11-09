import { describe, expect, it } from 'vitest'
import { fieldLabels } from '../src/views.js'
import {
  conditionText,
  fieldLabel,
  fieldLabelFor,
  fieldWords,
  isStatusField,
  sectionLabel,
  statusLabel,
  statusValue,
  statusWords,
  vocabularyRule,
} from '../src/words.js'

describe('the words pages and the agent share', () => {
  it('names a state and a field as the pages do, and leaves what nobody named as it came', () => {
    expect(statusLabel('shipped')).toBe('已发货')
    expect(statusLabel('open')).toBe('待处理')
    // A tenant's own state is its own word: shown as it is, not borrowed from a default.
    expect(statusLabel('awaiting_qc')).toBe('awaiting_qc')
    expect(fieldLabel('order_no')).toBe('订单号')
    expect(fieldLabel('signed_at')).toBe('签收时间')
    expect(fieldLabel('x_custom_field')).toBe('x_custom_field')
  })

  it("keeps every name a list already shows under the list's own word", () => {
    for (const [name, word] of Object.entries(fieldLabels)) expect(fieldWords[name]).toBe(word)
  })

  it('gives the agent every word of both tables, and tells it what to do with a name outside them', () => {
    const rule = vocabularyRule()
    for (const [name, word] of Object.entries(statusWords)) expect(rule).toContain(`${name}=${word}`)
    for (const [name, word] of Object.entries(fieldWords)) expect(rule).toContain(`${name}=${word}`)
    expect(rule).toMatch(/照原样写/)
    expect(rule).toContain('Chinese UI vocabulary for Chinese replies only')
    expect(rule).toContain('never force Chinese wording')
    // It goes into the system prompt, where a `{{` would be read as a variable and fail the assembly.
    expect(rule).not.toContain('{{')
  })

  it("names a field on a document as that document's own page does, and a part of a document by one word", () => {
    // An order's total is 订单总额 on the order list, and wherever else that order is shown.
    expect(fieldLabelFor('sales_order', 'total_amount')).toBe('订单总额')
    expect(fieldLabelFor('sales_quotation', 'total_amount')).toBe('总额')
    expect(fieldLabelFor('inventory_item_detail', 'reason')).toBe('变动原因')
    // A name several documents carry takes the word true of them all.
    expect(fieldLabel('reason')).toBe('原因')
    expect(sectionLabel('items')).toBe('明细行')
    expect(sectionLabel('adjustments')).toBe('价格调整')
    expect(sectionLabel('order_no')).toBe('订单号')
    expect(fieldLabel('quote_drift')).toBe('与报价的差额')
  })

  it('has a word for every name the todo page shows a document under', () => {
    // The todo page kept a table of its own for these, and half of them said something else there.
    for (const name of [
      'reason',
      'items',
      'adjustments',
      'total_amount',
      'product_name_snapshot',
      'round_no',
      'action',
      'comment',
      'acted_at',
      'computed_total',
      'adjusted_total',
      'adjustments_total',
      'estimated_total',
      'customer_name_snapshot',
      'vendor_name_snapshot',
      'quantity',
      'unit_price',
      'amount',
      'spec',
      'unit',
      'payment_terms',
      'delivery_terms',
      'quote_date',
      'valid_until',
      'submitted_at',
      'created_at',
      'updated_at',
      'quote_number',
      'revision_no',
      'approver_id',
      'sequence_no',
      'entries',
      'approval_records',
      'status',
      'currency',
      'remarks',
    ])
      expect(sectionLabel(name), name).toMatch(/[\u4e00-\u9fff]/)
  })

  it('reads a state as a person types it, and says a condition in words', () => {
    expect(statusValue(' 已发货 ')).toBe('shipped')
    expect(statusValue('shipped')).toBe('shipped')
    // A tenant's own state has no word here: it is what was typed.
    expect(statusValue('待质检')).toBe('待质检')
    expect(isStatusField('status')).toBe(true)
    expect(isStatusField('approval_status')).toBe(true)
    expect(isStatusField('statuses')).toBe(false)
    expect(conditionText('status', 'open')).toBe('状态：待处理')
    expect(conditionText('customer_name_snapshot', '泰安医院')).toBe('客户：泰安医院')
    expect(conditionText('x_custom', 'v')).toBe('x_custom：v')
  })
})
