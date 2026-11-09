import { describe, expect, it } from 'vitest'
import { type BusinessRow, businessRows, emptyFilter, filterRows } from './business-data.js'

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

describe('todo rows', () => {
  it('say which document each todo is about, so the pane stays on it while the agent works on that document', () => {
    const [row] = businessRows({
      operationId: 'my-open-todos',
      result: {
        data: [
          {
            id: 'todo-1',
            employeeId: 'e',
            entityType: 'timesheet_header',
            entityId: 'th-9',
            title: '审批 何丽萍 06/22 周超时工时',
            description: null,
            todoType: 'approval',
            status: 'open',
            dueAt: null,
            target: null,
          },
        ],
      },
    } as never)
    expect(row!.subject).toEqual({ type: 'timesheet_header', id: 'th-9' })
  })

  it('name a document ORYH gave no title by its kind, not by its internal type', () => {
    const todo = (entityType: string) => ({
      id: `todo-${entityType}`,
      employeeId: 'e',
      entityType,
      entityId: 'x',
      title: '审批请假',
      description: null,
      todoType: 'approval',
      status: 'open',
      dueAt: null,
      target: null,
    })
    const rows = businessRows({
      operationId: 'my-open-todos',
      result: { data: [todo('employee_leave'), todo('warranty_card')] },
    } as never)
    expect(rows.map(row => row.secondary)).toEqual(['请假单', 'warranty_card'])
    expect(rows[0]!.fields[0]).toEqual(['关联对象', '请假单'])
  })
})
