/**
 * The forms an agent put in a conversation, read from the session's own record.
 *
 * `oryh_chat_form` returns at once and keeps nothing: the form is the tool call, and its state is what
 * came after it in the session — the call failing, or the person's message that submitted it. So a form
 * is found the same way after a reload as while the turn is live, and a form already submitted is known
 * to be without asking the Host.
 */
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CustomForm } from '@oryh/dsh-analytics/types'

export const CHAT_FORM_TOOL = 'oryh_chat_form'
export const CHAT_FORM_KIND = 'oryh-chat-form' as const

type Scalar = string | number | boolean | null
type Row = Record<string, Scalar>

/** One form in a conversation. */
export interface ChatFormShown {
  readonly callId: string
  /** The call's argument as the agent wrote it, sent back with a submission. */
  readonly definitionJson: string
  readonly form: CustomForm
  readonly data: Record<string, Row[]>
  readonly values: Record<string, Scalar | Row[]>
  /** The tool refused it, so there is nothing to fill in. */
  readonly failed: boolean
  /** The person's message submitting it is in the conversation. */
  readonly submitted: boolean
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): value is string => typeof value === 'string'
const optional = (value: unknown, is: (value: unknown) => boolean) => value === undefined || is(value)
const scalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)
const rows = (value: unknown): value is Row[] =>
  Array.isArray(value) && value.every(row => record(row) && Object.values(row).every(scalar))
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'record', 'product', 'lines']

/**
 * Whether a field is one this page can draw without reading through something that is not there.
 *
 * The arguments are the model's, read from the call as it was logged — before the Host has said whether
 * it accepts the form. The Host holds a form to more than this (names, lengths, which reference may be
 * typed by hand); here it is only the shape the components read, so that one the Host is about to refuse
 * is not drawn at all, instead of taking the conversation's view down with it.
 */
function drawableField(value: unknown, nested = false): boolean {
  if (!record(value) || !text(value.name) || !text(value.label) || !FIELD_TYPES.includes(value.type as string))
    return false
  if (value.type === 'lines' && nested) return false
  return (
    optional(value.options, v => Array.isArray(v) && v.every(text)) &&
    optional(value.source, v => record(v) && text(v.data) && text(v.value) && text(v.label)) &&
    optional(value.lookup, v => record(v) && text(v.collection) && text(v.label) && optional(v.code, text)) &&
    optional(value.defaults, v => record(v) && Object.values(v).every(text)) &&
    optional(value.min, v => typeof v === 'number') &&
    optional(value.max, v => typeof v === 'number') &&
    optional(value.fields, v => Array.isArray(v) && v.every(field => drawableField(field, true))) &&
    optional(value.computed, drawableComputed)
  )
}

function drawableComputed(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      item =>
        record(item) &&
        text(item.name) &&
        text(item.label) &&
        optional(item.multiply, v => Array.isArray(v) && v.length === 2 && v.every(text)) &&
        optional(item.sum, text) &&
        optional(item.zeroWhen, text),
    )
  )
}

/**
 * What a submission says of itself, which is how a later reader knows the form was sent.
 *
 * Data, not copy: this matches the text of session records written before a submission's source named
 * its form, in the words the Host composed them in then. It is not shown to anyone, so it is not in the
 * plugin's word list and does not follow the locale.
 */
const SUBMITTED_MARKER = /（表单编号 ([\w:.-]{1,200})）/

/**
 * A form from a tool call's arguments, as far as a browser needs to draw it. The Host holds the same
 * text to what a form may be, both when it is shown and when it is submitted.
 * @param callId - the call.
 * @param argumentsJson - the call's arguments as logged.
 */
export function shownForm(callId: string, argumentsJson: string): ChatFormShown | undefined {
  let definitionJson: unknown
  let definition: unknown
  try {
    definitionJson = (JSON.parse(argumentsJson) as { formJson?: unknown }).formJson
    definition = typeof definitionJson === 'string' ? JSON.parse(definitionJson) : undefined
  } catch {
    return undefined
  }
  if (typeof definitionJson !== 'string' || !record(definition) || !record(definition.form)) return undefined
  const form = definition.form as unknown as CustomForm
  if (
    !text(form.name) ||
    !text(form.label) ||
    !Array.isArray(form.fields) ||
    !form.fields.every(field => drawableField(field)) ||
    !optional(form.computed, drawableComputed)
  )
    return undefined
  // Options and starting values are kept where they are what they claim to be, and left out where not.
  const data = record(definition.data) ? Object.entries(definition.data).filter(([, value]) => rows(value)) : []
  const values = record(definition.values)
    ? Object.entries(definition.values).filter(([, value]) => scalar(value) || rows(value))
    : []
  return {
    callId,
    definitionJson,
    form,
    data: Object.fromEntries(data) as Record<string, Row[]>,
    values: Object.fromEntries(values) as Record<string, Scalar | Row[]>,
    failed: false,
    submitted: false,
  }
}

/** A session event, as far as this reads one. */
export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

/**
 * What an event says about a form, if anything.
 * @returns the form it shows, or the id of the form it fails or submits.
 */
export function formEvent(
  event: SessionEventLike,
): { shown: ChatFormShown } | { failed: string } | { submitted: string } | undefined {
  const data = event.data
  if (!record(data)) return undefined
  if (event.type === 'tool/call') {
    if (data.name !== CHAT_FORM_TOOL || typeof data.callId !== 'string' || typeof data.arguments !== 'string')
      return undefined
    const shown = shownForm(data.callId, data.arguments)
    return shown ? { shown } : undefined
  }
  if (event.type === 'tool/result') {
    const message = record(data.message) ? data.message : undefined
    const source = message && record(message.source) ? message.source : undefined
    return source && typeof source.callId === 'string' && message?.isError === true
      ? { failed: source.callId }
      : undefined
  }
  if (event.type === 'user/message') {
    const source = record(data.source) ? data.source : undefined
    if (source?.kind !== 'user') return undefined
    // The Host names the form on the message's source (host-pane composed.ts); the words are not read.
    const composed = record(source.oryh) ? source.oryh : undefined
    if (composed?.by === 'chat-form' && typeof composed.formCallId === 'string')
      return { submitted: composed.formCallId }
    // A submission recorded before the source carried it says so only in its first line.
    const text = Array.isArray(data.content)
      ? data.content.map(block => (record(block) && typeof block.text === 'string' ? block.text : '')).join('\n')
      : ''
    const match = SUBMITTED_MARKER.exec(text)
    return match ? { submitted: match[1]! } : undefined
  }
  return undefined
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A form the agent put in the conversation, and whether it was since refused or submitted. */
    'oryh-chat-form': ChatFormShown
  }
}

/** One hidden node per form, at the turn that showed it; what came after only changes its state. */
export const chatFormDefinition: ConversationNodeDefinition<ChatFormShown | null> = {
  kind: CHAT_FORM_KIND,
  target: 'chat',
  match: event => {
    const found = formEvent(event)
    if (found === undefined) return null
    if ('shown' in found) return { id: found.shown.callId, role: 'start' }
    return { id: 'failed' in found ? found.failed : found.submitted, role: 'update' }
  },
  start: (_context, match) => {
    const found = formEvent(match.event)
    return found !== undefined && 'shown' in found ? found.shown : null
  },
  update: (context, match) => {
    const found = formEvent(match.event)
    if (context.state === null || found === undefined || 'shown' in found) return context.state
    return 'failed' in found ? { ...context.state, failed: true } : { ...context.state, submitted: true }
  },
  buildViewNode: context => {
    const start = context.start
    if (start === undefined || context.state === null || context.state === undefined) return null
    return {
      key: context.key,
      kind: CHAT_FORM_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: start.event.seq,
      location: start.location,
      visibility: 'hidden',
      data: context.state,
    } satisfies ChatNode<'oryh-chat-form'>
  },
}
