import { describe, it, expect } from 'vitest'
import { parseExpenseFields, MemoryExpenseStore, type ExpenseFields, type ExpenseRecord } from '../src/index.js'

const fields: ExpenseFields = {
  title: '差旅报销', claimDate: '2026-09-08', currency: 'CNY',
  items: [{ expenseDate: '2026-09-07', category: 'travel', amount: '120.50', merchant: '机场大巴', invoiceNumber: 'INV-1', notes: '' }],
}

describe('expense field parsing', () => {
  it('normalises amounts to two decimals and uppercases the currency', () => {
    const parsed = parseExpenseFields({ ...fields, currency: 'cny', items: [{ ...fields.items[0]!, amount: '120.5' }] })
    expect(parsed.currency).toBe('CNY')
    expect(parsed.items[0]!.amount).toBe('120.50')
  })
  it('rejects amounts outside the documented bounds', () => {
    for (const amount of ['0', '-1', '1.234', '10000000', 'abc']) {
      expect(() => parseExpenseFields({ ...fields, items: [{ ...fields.items[0]!, amount }] })).toThrow()
    }
  })
  it('rejects an invalid currency, an impossible date and an empty or oversized item list', () => {
    expect(() => parseExpenseFields({ ...fields, currency: 'CNYX' })).toThrow()
    expect(() => parseExpenseFields({ ...fields, claimDate: '2026-02-30' })).toThrow()
    expect(() => parseExpenseFields({ ...fields, items: [] })).toThrow()
    expect(() => parseExpenseFields({ ...fields, items: Array.from({ length: 101 }, () => fields.items[0]!) })).toThrow()
  })
  it('allows blank amounts and dates only while the draft is incomplete', () => {
    const draft = { ...fields, claimDate: '', items: [{ ...fields.items[0]!, amount: '', expenseDate: '' }] }
    expect(() => parseExpenseFields(draft, false)).not.toThrow()
    expect(() => parseExpenseFields(draft)).toThrow()
  })
  it('requires a complete attachment receipt when one is present', () => {
    const withAttachment = { ...fields, items: [{ ...fields.items[0]!, attachment: { id: 'a', filename: 'r.pdf', sha256: 'x' } }] }
    expect(parseExpenseFields(withAttachment).items[0]!.attachment).toEqual({ id: 'a', filename: 'r.pdf', sha256: 'x' })
    expect(() => parseExpenseFields({ ...fields, items: [{ ...fields.items[0]!, attachment: { id: '', filename: 'r.pdf', sha256: 'x' } }] })).toThrow()
  })
  it('reports an expense conflict for a malformed payload', () => {
    expect(() => parseExpenseFields('not-an-object')).toThrow(expect.objectContaining({ code: 'expense-conflict' }))
  })
})

describe('draft store', () => {
  it('permits one writer per revision', async () => {
    const store = new MemoryExpenseStore()
    const record: ExpenseRecord = { id: 'draft', revision: 1, scope: 's', fields, state: 'editing', updatedAt: '2026-09-08T00:00:00.000Z' }
    await store.append(record, 0)
    await expect(store.append({ ...record, revision: 2 }, 0)).rejects.toThrow(/草稿已改变/)
    await store.append({ ...record, revision: 2 }, 1)
    expect((await store.list())[0]!.revision).toBe(2)
  })
})
