import { expect, it } from 'vitest'
import { dictionaries, english } from './dictionary.js'
import { displayField, displaySection, displayStatus, displayStatusValue } from './display-language.js'
import { wordsOf } from './pane-test.js'

it('translates built-in vocabulary by stable key without touching tenant labels', () => {
  const zh = wordsOf(dictionaries),
    en = wordsOf(english)
  // A built-in field translates under its API name; a tenant's different label for it does not.
  expect(displayField(zh, 'total_amount', '订单总额')).toBe('订单总额')
  expect(displayField(en, 'total_amount', '订单总额')).toBe('Total')
  expect(displayField(en, 'total_amount', '总额（自定义）')).toBe('总额（自定义）')
  // A tenant field whose label happens to read like a built-in word stays as the tenant wrote it.
  expect(displayField(en, 'tenant_stage', '状态')).toBe('状态')
  expect(displayStatus(en, 'shipped')).toBe('Shipped')
  expect(displayStatus(zh, 'shipped')).toBe('已发货')
  expect(displayStatus(en, 'tenant_review')).toBe('tenant_review')
  expect(displaySection(en, 'items', '明细行')).toBe('Line items')
  expect(displaySection(en, 'tenant_part', '明细行')).toBe('明细行')
  expect(displayField(en, 'order_no', 'QT-2026-001')).toBe('QT-2026-001')
})

it('round-trips English filter labels to machine states without changing tenant states', () => {
  const en = wordsOf(english),
    zh = wordsOf(dictionaries)
  expect(displayStatusValue(en, 'Shipped')).toBe('shipped')
  expect(displayStatusValue(en, '  APPROVED  ')).toBe('approved')
  expect(displayStatusValue(zh, '已发货')).toBe('shipped')
  expect(displayStatusValue(en, 'tenant_review')).toBe('tenant_review')
})
