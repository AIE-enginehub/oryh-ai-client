import { describe, expect, it } from 'vitest'
import { CHAT_FORM_TOOL, chatFormDefinition, formEvent, shownForm } from './chat-form.js'

const definition = {
  form: {
    name: 'order',
    label: '录入销售订单',
    instruction: '创建一张销售订单，创建后不提交审批。',
    fields: [{ name: 'order_date', label: '订单日期', type: 'date', required: true }],
  },
  values: { order_date: '2026-10-09' },
}
const call = {
  type: 'tool/call',
  data: { name: CHAT_FORM_TOOL, callId: 'call-1', arguments: JSON.stringify({ formJson: JSON.stringify(definition) }) },
}

describe("the forms read from a session's record", () => {
  it('finds the form a tool call showed, with the text to send back on submitting', () => {
    const found = formEvent(call)
    expect(found).toMatchObject({ shown: { callId: 'call-1', failed: false, submitted: false } })
    const shown = shownForm('call-1', call.data.arguments)!
    expect(shown.form.label).toBe('录入销售订单')
    expect(shown.values).toEqual({ order_date: '2026-10-09' })
    expect(JSON.parse(shown.definitionJson)).toEqual(definition)
    // Another tool's call, and arguments that are no form, are nobody's form.
    expect(formEvent({ type: 'tool/call', data: { ...call.data, name: 'oryh_request' } })).toBeUndefined()
    expect(shownForm('c', '{"formJson":"not json"}')).toBeUndefined()
    expect(shownForm('c', JSON.stringify({ formJson: JSON.stringify({ form: { name: 'x' } }) }))).toBeUndefined()
    // A form the Host is about to refuse is in the conversation before its refusal is: what the components
    // would read through and fall over on is not drawn at all.
    const malformed = (form: object, extra: object = {}) =>
      shownForm(
        'c',
        JSON.stringify({ formJson: JSON.stringify({ form: { name: 'x', label: 'X', ...form }, ...extra }) }),
      )
    const field = { name: 'a', label: 'A', type: 'text', required: true }
    expect(malformed({ fields: [field] })).toBeDefined()
    expect(malformed({ fields: [null] })).toBeUndefined()
    expect(malformed({ fields: [{ ...field, type: 'slider' }] })).toBeUndefined()
    expect(malformed({ fields: [{ ...field, type: 'select', options: [{ value: 1 }] }] })).toBeUndefined()
    expect(malformed({ fields: [{ ...field, type: 'lines', fields: [null] }] })).toBeUndefined()
    expect(malformed({ fields: [{ ...field, type: 'record', lookup: 'customers' }] })).toBeUndefined()
    expect(malformed({ fields: [field], computed: [{ name: 't', label: 'T', multiply: ['a'] }] })).toBeUndefined()
    // Options and starting values that are not what they claim to be are left out, and the form still shows.
    const loose = malformed(
      { fields: [field] },
      { data: { ok: [{ id: '1' }], bad: 'x' }, values: { a: 'v', b: { c: 1 } } },
    )!
    expect(loose.data).toEqual({ ok: [{ id: '1' }] })
    expect(loose.values).toEqual({ a: 'v' })
  })

  it('knows a form the tool refused, and one the person has submitted', () => {
    const refused = { type: 'tool/result', data: { message: { isError: true, source: { callId: 'call-1' } } } }
    expect(formEvent(refused)).toEqual({ failed: 'call-1' })
    expect(formEvent({ type: 'tool/result', data: { message: { source: { callId: 'call-1' } } } })).toBeUndefined()
    const message = (kind: string, text: string) => ({
      type: 'user/message',
      data: { id: 'm', source: { kind }, content: [{ type: 'text', text }] },
    })
    expect(formEvent(message('user', '我填好了「录入销售订单」（表单编号 call-1）。\n- 订单日期：2026-10-09'))).toEqual(
      {
        submitted: 'call-1',
      },
    )
    // What the Host writes now names the form on the message's source: its words can change, and a form
    // already sent stays sent.
    const marked = {
      type: 'user/message',
      data: {
        id: 'm',
        source: { kind: 'user', oryh: { by: 'chat-form', formCallId: 'call-9' } },
        content: [{ type: 'text', text: 'Submitted the order form.' }],
      },
    }
    expect(formEvent(marked)).toEqual({ submitted: 'call-9' })
    // Other things the Host composes are not a form's submission, whatever they say.
    expect(
      formEvent({ ...marked, data: { ...marked.data, source: { kind: 'user', oryh: { by: 'page-question' } } } }),
    ).toBeUndefined()
    // Only the person's own message submits; a note some plugin put in the conversation does not.
    expect(formEvent(message('plugin', '（表单编号 call-1）'))).toBeUndefined()
    expect(formEvent(message('user', '帮我看看这张表单'))).toBeUndefined()
  })

  it('keeps one state per form: shown, then refused or submitted by what came after', () => {
    const d = chatFormDefinition
    expect(d.match(call as never)).toEqual({ id: 'call-1', role: 'start' })
    const shown = d.start({} as never, { event: call } as never, {} as never)!
    const submitted = {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '（表单编号 call-1）' }] },
    }
    expect(d.match(submitted as never)).toEqual({ id: 'call-1', role: 'update' })
    expect(d.update({ state: shown } as never, { event: submitted } as never)).toMatchObject({ submitted: true })
    const refused = { type: 'tool/result', data: { message: { isError: true, source: { callId: 'call-1' } } } }
    expect(d.update({ state: shown } as never, { event: refused } as never)).toMatchObject({ failed: true })
    expect(d.match({ type: 'turn/end', data: {} } as never)).toBeNull()
  })
})
