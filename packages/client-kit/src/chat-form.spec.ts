import { describe, expect, it } from 'vitest'
import { applyFields } from './chat-form.js'

describe('a fill of a form that describes itself', () => {
  it('sets a field that still holds what the agent read, and keeps one the person has changed since', () => {
    const current = { reason: '', date: '2026-10-09', urgent: false }
    const base = { reason: '', date: '2026-10-08', urgent: false }
    expect(applyFields(current, base, { reason: '客户要求改期', date: '2026-10-12', urgent: true })).toEqual({
      next: { reason: '客户要求改期', date: '2026-10-09', urgent: true },
      applied: ['reason', 'urgent'],
      kept: ['date'],
    })
  })

  it('takes a field as applied when it already holds what the agent wants, and leaves the rest of the form alone', () => {
    const current = { reason: '已有', note: '不相干' }
    expect(applyFields(current, { reason: '别的' }, { reason: '已有' })).toEqual({
      next: current,
      applied: ['reason'],
      kept: [],
    })
    // A field the form has never held counts as empty on both sides.
    expect(applyFields({}, {}, { fresh: 'x' }).applied).toEqual(['fresh'])
  })

  it('takes lines as one field: replaced while they are as the agent read them, kept whole once the person touched a row', () => {
    const read = [{ product: 'P-01', qty: '1' }]
    const wanted = [
      { product: 'P-01', qty: '2' },
      { product: 'P-02', qty: '5' },
    ]
    // Equal by what they hold, not by being the same list.
    expect(applyFields({ items: [{ product: 'P-01', qty: '1' }] }, { items: read }, { items: wanted })).toEqual({
      next: { items: wanted },
      applied: ['items'],
      kept: [],
    })
    const typed = { items: [{ product: 'P-01', qty: '3' }] }
    expect(applyFields(typed, { items: read }, { items: wanted })).toEqual({
      next: typed,
      applied: [],
      kept: ['items'],
    })
    // Lines a form has never held are no rows on both sides.
    expect(applyFields({}, {}, { items: wanted }).applied).toEqual(['items'])
  })
})
