/**
 * A custom page's form, as it describes itself to the agent (docs/56 §15, §19).
 *
 * A page written with Harness components draws its forms itself; one written as HTML draws them in its
 * frame. Either way the form is the same declared thing, so what Chat is told of it — its fields, the
 * choices of a select, what a place on it is called — is worked out here once, for both.
 */
import type { CustomForm, CustomFormField } from '@oryh/dsh-analytics/types'
import type { FormColumnSpec, FormFieldSpec, FormValue } from '@oryh/dsh-pane/types'
import { formatValue } from './format.js'
import type { Words } from './words.js'

type Row = Record<string, unknown>
type Data = Record<string, unknown>

/** One choice of a select: what it holds, what a person calls it, and the item of the result it came from. */
export interface FormChoice {
  value: string
  label: string
  item?: Row
}

/** The choices of a select: its fixed options, or the items of the page's result it draws them from. */
export function formChoices(field: CustomFormField, data: Data): FormChoice[] {
  if (field.options) return field.options.map(value => ({ value, label: value }))
  const items = field.source && Array.isArray(data[field.source.data]) ? (data[field.source.data] as Row[]) : []
  return items.map(item => ({
    value: formatValue(item?.[field.source!.value]),
    label: formatValue(item?.[field.source!.label]),
    item,
  }))
}

function column(field: CustomFormField, data: Data): FormColumnSpec {
  const options = field.type === 'select' ? formChoices(field, data) : []
  return {
    name: field.name,
    label: field.label,
    type: field.type as FormColumnSpec['type'],
    ...(field.required ? { required: true } : {}),
    // A long list is the page's data, which the agent reads elsewhere; a short one is the choices.
    ...(field.type === 'select' && options.length <= 50
      ? { options: options.map(({ value, label }) => ({ value, label })) }
      : {}),
  }
}

/** The fields of a form, and its lines with their columns, in the shape every form describes itself in. */
export function describeForm(form: CustomForm, data: Data): FormFieldSpec[] {
  return form.fields.map(
    (field): FormFieldSpec =>
      field.type === 'lines'
        ? {
            name: field.name,
            label: field.label,
            type: 'lines',
            columns: (field.fields ?? []).map(sub => column(sub, data)),
            ...(field.min === undefined ? {} : { min: field.min }),
            max: field.max ?? 50,
          }
        : column(field, data),
  )
}

/**
 * The rows a fill brought, with what a choice brings along: a line whose select has defaults gets them
 * where the fill left the target empty, as it would had a person picked that choice. Lines the fill did
 * not touch are left as they are.
 * @param next - the form after the fill.
 * @param before - the form before it.
 */
export function withLineDefaults(
  form: CustomForm,
  data: Data,
  next: Record<string, FormValue>,
  before: Record<string, FormValue>,
): Record<string, FormValue> {
  const filled = { ...next }
  for (const field of form.fields) {
    const rows = next[field.name]
    if (field.type !== 'lines' || !Array.isArray(rows)) continue
    if (JSON.stringify(rows) === JSON.stringify(before[field.name])) continue
    filled[field.name] = rows.map(line => {
      const row = { ...line }
      for (const sub of field.fields ?? []) {
        if (sub.type !== 'select' || !sub.defaults || !row[sub.name]) continue
        const chosen = formChoices(sub, data).find(option => option.value === row[sub.name])
        for (const [target, source] of Object.entries(sub.defaults)) {
          const value = chosen?.item?.[source]
          if ((row[target] ?? '') === '' && value !== undefined && value !== null) row[target] = formatValue(value)
        }
      }
      return row
    })
  }
  return filled
}

/** The field a dotted path is in, and — for a place in a line — which row and which column. */
function placeOf(form: CustomForm, path: string) {
  const [name, index, sub] = path.split('.')
  const field = form.fields.find(candidate => candidate.name === name)
  return { field, index, column: sub === undefined ? undefined : field?.fields?.find(c => c.name === sub) }
}

/** What a place on the form is called to a person: `items.1.quantity` as 「明细第 2 行 数量」. */
export function formPlaceLabel(t: Words, form: CustomForm, path: string): string {
  const { field, index, column } = placeOf(form, path)
  if (!field) return path
  if (index === undefined) return field.label
  const row = Number(index) + 1
  return column
    ? t('formPlaceLineColumn', { field: field.label, row, column: column.label })
    : t('formPlaceLine', { field: field.label, row })
}

/** A value as the form shows it where that is not the value itself: a choice by its name. */
export function formPlaceFormat(form: CustomForm, data: Data, path: string, value: unknown): string | undefined {
  const { field, index, column } = placeOf(form, path)
  const select = index === undefined ? field : column
  return select?.type === 'select' ? formChoices(select, data).find(option => option.value === value)?.label : undefined
}
