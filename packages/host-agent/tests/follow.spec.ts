import { describe, expect, it } from 'vitest'
import { conditionsOf, writtenRecord } from '../src/follow.js'

describe('the record a write was about', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  it('is the collection of its path and the id the path names or ORYH answered with', () => {
    // An action on a record, and an update of one: the path names it.
    expect(writtenRecord({ method: 'POST', path: `/timesheet-headers/${id}/submit` }, '{"data":{}}')).toEqual({
      collection: 'timesheet-headers',
      id,
    })
    expect(
      writtenRecord({ method: 'PATCH', path: `/api/v1/todos/${id}?x=1`, body: { status: 'completed' } }, ''),
    ).toEqual({ collection: 'todos', id })
    // A create: the path names only the collection, and the answer says which record came of it.
    expect(writtenRecord({ method: 'POST', path: '/expense-claims', body: {} }, `{"data":{"id":"${id}"}}`)).toEqual({
      collection: 'expense-claims',
      id,
    })
  })
  it('names none when the call does not say which record', () => {
    expect(writtenRecord({ method: 'POST', path: '/todos/batch' }, '{"data":[{"id":"a"}]}')).toBeUndefined()
    expect(writtenRecord({ method: 'POST', body: { customer_id: id } }, '{"data":{}}')).toBeUndefined()
    // A body's own ids are other things: a customer is not the order.
    expect(
      writtenRecord({ method: 'POST', path: '/sales-orders', body: { customer_id: id } }, 'not json'),
    ).toBeUndefined()
  })
})

describe('the conditions a read narrowed its list by', () => {
  it('are the filters or query it carried and the query string of its path, as text', () => {
    expect(conditionsOf({ collection: 'sales-orders', filters: { status: 'shipped', urgent: true, qty: 2 } })).toEqual({
      status: 'shipped',
      urgent: 'true',
      qty: '2',
    })
    expect(
      conditionsOf({ method: 'GET', path: '/api/v1/todos?employee_id=e-1&status=open', query: { status: 'done' } }),
    ).toEqual({ employee_id: 'e-1', status: 'done' })
  })

  it('leave out how much to read and in what order, and anything that is not a plain value', () => {
    expect(
      conditionsOf({
        collection: 'todos',
        filters: {
          page: 2,
          size: 50,
          order_by: '-updated_at',
          include: 'target',
          status: ' ',
          nested: { a: 1 },
          list: [1],
        },
      }),
    ).toEqual({})
    expect(conditionsOf({ path: '/todos?page=3&limit=5' })).toEqual({})
    expect(conditionsOf('/todos?status=open')).toEqual({})
    expect(conditionsOf(undefined)).toEqual({})
    // A name that could not be a parameter, a value too long to be one, and no more than ten in all.
    expect(conditionsOf({ filters: { 'a b': 'x', long: 'y'.repeat(201) } })).toEqual({})
    const many = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`f${index}`, 'v']))
    expect(Object.keys(conditionsOf({ filters: many }))).toHaveLength(10)
  })
})
