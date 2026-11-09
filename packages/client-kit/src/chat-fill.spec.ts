// @vitest-environment jsdom
import { act, createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ChatActivity } from './chat-context.js'
import { type ChatFill, changedPaths, isFilled, useChatFill, valueAt, withValueAt } from './chat-fill.js'

const line = (amount: string, merchant = '') => ({ expenseDate: '2026-10-06', category: 'transport', amount, merchant })

describe('what the agent changed on a form', () => {
  it('names each field that differs, a row added to a list as that row, and a list that shrank as the list', () => {
    const before = { title: '', claimDate: '2026-10-07', items: [line('')] }
    const after = { title: '打车费', claimDate: '2026-10-07', items: [line('86', '滴滴出行')] }
    expect(changedPaths(before, after)).toEqual(['title', 'items.0.amount', 'items.0.merchant'])
    expect(changedPaths(before, before)).toEqual([])
    // A row past the end of the old list was added: it is one place, whatever it holds.
    expect(changedPaths(before, { ...before, items: [line(''), line('12')] })).toEqual(['items.1'])
    expect(changedPaths(before, { ...before, items: [line('5'), line('12'), line('7')] })).toEqual([
      'items.0.amount',
      'items.1',
      'items.2',
    ])
    // Rows gone: which ones has no good answer, so it is the list.
    expect(changedPaths({ items: [line('1'), line('2')] }, { items: [line('2')] })).toEqual(['items'])
    // A field one side lacks counts, and a field holding nothing either way does not.
    expect(changedPaths({ a: '1' }, { a: '1', b: '2' })).toEqual(['b'])
    expect(changedPaths({ a: null }, { a: undefined })).toEqual([])
  })

  it('reads and replaces a value at a path without touching the form it was given', () => {
    const form = { title: 'a', items: [line('1'), line('2')] }
    expect(valueAt(form, 'items.1.amount')).toBe('2')
    expect(valueAt(form, 'items.5.amount')).toBeUndefined()
    const next = withValueAt(form, 'items.1.amount', '9')
    expect(next.items[1]!.amount).toBe('9')
    expect(form.items[1]!.amount).toBe('2')
    expect(next.items[0]).toBe(form.items[0])
    expect(withValueAt(form, 'title', 'b').title).toBe('b')
  })

  it('marks a field for what was filled in it, on it, or under it', () => {
    const fill = { filled: new Set(['title', 'items.0.amount', 'lines']) }
    expect(isFilled(fill, 'title')).toBe(true)
    expect(isFilled(fill, 'items.0.amount')).toBe(true)
    // A row is marked for a field of it, and a row of a list that was replaced whole for the list.
    expect(isFilled(fill, 'items.0')).toBe(true)
    expect(isFilled(fill, 'lines.2.hours')).toBe(true)
    expect(isFilled(fill, 'items.1')).toBe(false)
    expect(isFilled(fill, 'titles')).toBe(false)
  })
})

interface Form {
  title: string
  items: ReturnType<typeof line>[]
}
/** A form that keeps its agent's fill, driven by the test. */
function mount(start: Form) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const seen: { fill?: ChatFill<Form>; form: Form; set?: (form: Form) => void } = { form: start }
  let setActivity: (value: ChatActivity) => void = () => {}
  function Page() {
    const [activity, set] = useState<ChatActivity>('idle')
    setActivity = set
    const [form, setForm] = useState(start)
    seen.form = form
    seen.set = setForm
    seen.fill = useChatFill(activity, form)
    return null
  }
  const node = document.createElement('div')
  const root = createRoot(node)
  return {
    seen,
    start: () => act(async () => root.render(h(Page))),
    activity: (value: ChatActivity) => act(async () => setActivity(value)),
    /** The agent's fill lands: the page records it and puts it in place. */
    fill: (after: Form) =>
      act(async () => {
        seen.fill!.record(seen.form, after)
        seen.set!(after)
      }),
    edit: (form: Form) => act(async () => seen.set!(form)),
    close: () => act(async () => root.unmount()),
  }
}

describe('a page keeping the fill of its form', () => {
  it("takes a fill back row by row: changed fields restored, added rows removed, the person's own rows left", async () => {
    const page = mount({ title: '', items: [line('')] })
    await page.start()
    await page.fill({ title: '打车', items: [line('86'), line('12'), line('7')] })
    expect([...page.seen.fill!.filled]).toEqual(['title', 'items.0.amount', 'items.1', 'items.2'])
    expect(page.seen.fill!.changes.filter(change => change.added).map(change => change.path)).toEqual([
      'items.1',
      'items.2',
    ])
    // The person types in the second added row: it is theirs now, and stays.
    await page.edit({ title: '打车', items: [line('86'), line('12'), line('70')] })
    expect([...page.seen.fill!.filled]).toEqual(['title', 'items.0.amount', 'items.1'])
    expect(page.seen.fill!.undone()).toEqual({ title: '', items: [line(''), line('70')] })
    await page.close()
  })

  it('holds the form while the agent that filled it is still in the same turn, and lets go when the turn ends or waits', async () => {
    const page = mount({ title: '', items: [] })
    await page.start()
    // A fill applied with no turn running — a suggestion the person took up later — holds nothing.
    await page.fill({ title: 'a', items: [] })
    expect(page.seen.fill!.writing).toBe(false)
    await page.activity('running')
    expect(page.seen.fill!.writing).toBe(false)
    await page.fill({ title: 'b', items: [] })
    expect(page.seen.fill!.writing).toBe(true)
    // The agent stops to ask: the form is the person's again, and the turn that resumes is not held against it.
    await page.activity('waiting')
    expect(page.seen.fill!.writing).toBe(false)
    await page.activity('running')
    expect(page.seen.fill!.writing).toBe(false)
    await page.fill({ title: 'c', items: [] })
    expect(page.seen.fill!.writing).toBe(true)
    await page.activity('idle')
    expect(page.seen.fill!.writing).toBe(false)
    await page.close()
  })
})
