/**
 * A form inside a framed page, as Chat sees it (docs/56 §19).
 *
 * A page written as HTML draws its forms in a sandboxed frame, where nothing of the workbench runs. The
 * frame's bridge says what each form holds; this stands outside the frame for each of them: it describes
 * the form to the agent, hands the frame what Chat fills, and keeps the fill — the line saying what
 * changed, the marks, the way back — as every other form does.
 */

import { ChatFillNote, type ChatFormRegistry, type PageFace, useChatFill, useChatForm } from '@oryh/ai-client-kit'
import type { CustomForm } from '@oryh/dsh-analytics/types'
import type { FormLine, FormValue } from '@oryh/dsh-pane/types'
import { type ReactNode, useEffect } from 'react'
import { describeForm, formPlaceFormat, formPlaceLabel, withLineDefaults } from './form-chat.js'
import type { Words } from './words.js'

/** One form of a framed page, as its bridge reports it. */
export interface FrameFormReport {
  /** The form's name, and the row it belongs to when it is a row's: `follow:rows.3`. */
  id: string
  name: string
  row: string
  values: Record<string, FormValue>
  /** Submitted and waiting for the person's confirmation. */
  busy: boolean
}

/**
 * The page's forms that are not on screen, by what each is called. A form behind a row's button is there
 * once the person opens that row; until then the page has it and Chat cannot reach it.
 * @param declared - the page's forms.
 * @param open - the ids of the forms on screen: a form's name, or `name:row` for a row's.
 */
export function closedForms(declared: readonly CustomForm[], open: readonly string[]): string[] {
  return declared
    .filter(form => !open.some(id => id === form.name || id.startsWith(`${form.name}:`)))
    .map(form => form.label)
}

const TEXT_LIMIT = 10_000
const scalar = (value: unknown, checkbox: boolean): string | boolean =>
  checkbox ? value === true : typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : ''

/**
 * What a frame says of its forms, held to what the page declared: a form the page has, the fields that
 * form has, each in its own kind. Anything else in the message is dropped.
 * @param message - the `forms` of an `oryh-forms` message.
 * @param forms - the page's declared forms.
 */
export function readFrameForms(message: unknown, forms: readonly CustomForm[]): FrameFormReport[] {
  if (!Array.isArray(message)) return []
  const seen = new Set<string>()
  return message.slice(0, 12).flatMap((entry): FrameFormReport[] => {
    const { name, row, values, busy } = (entry ?? {}) as Record<string, unknown>
    const form = forms.find(candidate => candidate.name === name)
    if (!form || typeof row !== 'string' || row.length > 200) return []
    const id = row ? `${form.name}:${row}` : form.name
    if (seen.has(id)) return []
    seen.add(id)
    const held =
      values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {}
    return [
      {
        id,
        name: form.name,
        row,
        busy: busy === true,
        values: Object.fromEntries(
          form.fields.map((field): [string, FormValue] => {
            const value = held[field.name]
            if (field.type !== 'lines') return [field.name, scalar(value, field.type === 'checkbox')]
            const rows = Array.isArray(value) ? value.slice(0, field.max ?? 50) : []
            return [
              field.name,
              rows.map((line): FormLine => {
                const cells = line && typeof line === 'object' ? (line as Record<string, unknown>) : {}
                return Object.fromEntries(
                  (field.fields ?? []).map(sub => [sub.name, scalar(cells[sub.name], sub.type === 'checkbox')]),
                )
              }),
            ]
          }),
        ),
      },
    ]
  })
}

/** The fields two versions of a form differ in, with what the second holds: all the frame needs to be told. */
function changed(before: Record<string, FormValue>, after: Record<string, FormValue>): Record<string, FormValue> {
  return Object.fromEntries(
    Object.entries(after).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(before[name])),
  )
}

/**
 * One framed form, for Chat. Draws only the line above the frame that says what Chat filled.
 * @param props.face - what the page's slot handed it.
 * @param props.t - this plugin's words.
 * @param props.registry - the page owner's registry of its forms, from `useChatForms`.
 * @param props.report - the form as the frame last reported it.
 * @param props.form - its declaration.
 * @param props.data - the page's result, where a select's choices come from.
 * @param props.post - sends a message to the frame's bridge.
 */
export function FrameForm(props: {
  face: PageFace
  t: Words
  registry: ChatFormRegistry | undefined
  report: FrameFormReport
  form: CustomForm
  data: Record<string, unknown>
  post: (message: Record<string, unknown>) => void
}): ReactNode {
  const { face, t, registry, report, form, data, post } = props
  const fill = useChatFill(face.frame.activity, report.values)
  useChatForm(registry, {
    id: report.id,
    label: form.label,
    fields: describeForm(form, data),
    values: report.values,
    busy: report.busy,
    onFill: next => {
      const filled = withLineDefaults(form, data, next, report.values)
      fill.record(report.values, filled)
      post({ type: 'oryh-form-fill', form: report.id, values: changed(report.values, filled) })
    },
  })
  // The frame marks what the fill left standing, and holds the form while the agent is still at it.
  // Sent again whenever the form's content moves: a fill of its lines draws their rows anew, unmarked.
  const marks = [...fill.filled].join('\n')
  const held = JSON.stringify(report.values)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `held` is what the frame now shows.
  useEffect(() => {
    post({ type: 'oryh-form-marks', form: report.id, marks: marks ? marks.split('\n') : [] })
  }, [post, report.id, marks, held])
  useEffect(() => {
    post({ type: 'oryh-form-hold', form: report.id, on: fill.writing })
  }, [post, report.id, fill.writing])
  // Which form, when the page has one on every row: the row's place in its list, counted from one.
  const place = /\.(\d+)$/.exec(report.row)
  return (
    <ChatFillNote
      t={face.frame.t}
      fill={fill}
      label={path => formPlaceLabel(t, form, path)}
      format={(path, value) => formPlaceFormat(form, data, path, value)}
      onUndo={values => post({ type: 'oryh-form-fill', form: report.id, values: changed(report.values, values) })}
    >
      {place
        ? t('frameFormPendingRow', { label: form.label, row: Number(place[1]) + 1 })
        : t('frameFormPending', { label: form.label })}
    </ChatFillNote>
  )
}
