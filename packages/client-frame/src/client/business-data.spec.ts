import { describe, expect, it } from 'vitest'
import { type BusinessRow, emptyFilter, filterRows } from './business-data.js'

const rows: BusinessRow[] = [
  {
    id: 'a',
    title: '客户拜访',
    status: 'submitted',
    date: '2026-08-10',
    secondary: 'CNY',
    fields: [],
    entityType: 'expense_claim',
  },
  {
    id: 'b',
    title: '客户拜访',
    status: 'draft',
    date: '2026-08-21',
    secondary: 'CNY',
    fields: [],
    entityType: 'expense_claim',
  },
  {
    id: 'c',
    title: '客户拜访',
    status: 'submitted',
    date: '',
    secondary: 'USD',
    fields: [],
    entityType: 'expense_claim',
  },
  {
    id: 'd',
    title: '设备采购',
    status: 'submitted',
    date: '2026-09-01',
    secondary: 'CNY',
    fields: [],
    entityType: 'expense_claim',
  },
]
describe('loaded result filters', () => {
  it('combines filters and excludes undated records from bounded date ranges', () => {
    expect(
      filterRows(rows, { ...emptyFilter, text: '客户', status: 'submitted', from: '2026-08-01', to: '2026-08-31' }).map(
        row => row.id,
      ),
    ).toEqual(['a'])
  })
  it('keeps undated records last in both sort directions without mutating the source', () => {
    expect(filterRows(rows, emptyFilter).map(row => row.id)).toEqual(['d', 'b', 'a', 'c'])
    expect(filterRows(rows, { ...emptyFilter, descending: false }).map(row => row.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('does not treat a blank search as a filter and respects both inclusive boundaries', () => {
    expect(
      filterRows(rows, { ...emptyFilter, text: '  ', from: '2026-08-10', to: '2026-08-21' }).map(row => row.id),
    ).toEqual(['b', 'a'])
  })
})
