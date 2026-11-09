/**
 * A form in the conversation, drawn under the answer that showed it.
 *
 * Laid out for the Chat column, which is narrow: every field under its label, and each line of a lines
 * field as a small card of its own rather than a row of a table. What is typed stays here until the
 * person submits; the Host holds it to the form, and it goes on as their next message.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CustomComputed, CustomFormField } from '@oryh/dsh-analytics/types'
import { IconSearch } from '@tabler/icons-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ChatFormShown } from './chat-form.js'
import { formChoices } from './form-chat.js'
import { formatValue } from './format.js'
import type { Words } from './words.js'

/** What the conversation gives a form: the forms of one turn, and the way to hand one in. */
export interface ChatFormsInjected {
  keyedHooks: {
    forms: (turn: string) => ObservableSnapshot<readonly ChatFormShown[]>
  }
  /** Hands a filled-in form to the agent; rejects in words for the person. */
  submit(form: ChatFormShown, values: Record<string, unknown>): Promise<string>
  /** Searches an ORYH collection for a record field, a page at a time. */
  records(lookup: Lookup, query: string, page: number): Promise<{ rows: Chosen[]; total: number; pages: number }>
}

/** Where a record field looks: a collection, and the fields a record of it is named by. */
export interface Lookup {
  collection: string
  label: string
  code?: string | undefined
}

/** A record, as a lookup lists it. */
export interface Chosen {
  id: string
  code: string
  name: string
}

/** What the product catalogue is looked up by; the Host reads a `product` field the same way. */
const PRODUCT_LOOKUP: Lookup = { collection: 'products', label: 'name', code: 'product_code' }

/** Where a field looks, when it is one that chooses a record. */
export function lookupOf(field: CustomFormField): Lookup | undefined {
  if (field.type === 'product') return PRODUCT_LOOKUP
  return field.type === 'record' ? field.lookup : undefined
}

const lookupKey = (lookup: Lookup) => `${lookup.collection}|${lookup.label}|${lookup.code ?? ''}`
const recordName = (t: Words, record: Chosen) =>
  record.code ? t('chatFormRecordName', { name: record.name, code: record.code }) : record.name

/**
 * One record of an ORYH collection — a customer, a product, a project — chosen in a dialog that searches it.
 *
 * A collection is hundreds or thousands of records: too many for a list, and a name typed by hand is a
 * name the agent then has to guess at. The field shows what was chosen and opens the search; the search
 * asks ORYH as the person types, a page at a time.
 */
function RecordField({
  t,
  label,
  chosen,
  disabled,
  search,
  onChoose,
}: {
  t: Words
  label: string
  chosen: Chosen | undefined
  disabled: boolean
  search(query: string, page: number): Promise<{ rows: Chosen[]; total: number; pages: number }>
  onChoose(record: Chosen | undefined): void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ rows: Chosen[]; total: number; pages: number; page: number }>()
  const [note, setNote] = useState('')
  // The answer to an earlier keystroke must not replace the answer to a later one.
  const asked = useRef(0)
  const load = (text: string, page: number) => {
    const ticket = ++asked.current
    setNote(t('chatFormLookupSearching'))
    search(text, page).then(
      result => {
        if (ticket !== asked.current) return
        setFound(current => ({
          ...result,
          page,
          rows: page > 1 && current ? [...current.rows, ...result.rows] : result.rows,
        }))
        setNote(result.total === 0 ? t('chatFormLookupNone') : '')
      },
      reason => {
        if (ticket !== asked.current) return
        setNote(reason instanceof Error ? reason.message : t('chatFormLookupFailed'))
      },
    )
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` reads nothing that changes between renders.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => load(query.trim(), 1), 250)
    return () => clearTimeout(timer)
  }, [open, query])
  return (
    <>
      <span className="oryh-chat-lookup">
        <button
          type="button"
          className="oryh-chat-lookup-value"
          data-empty={chosen ? undefined : ''}
          aria-label={
            chosen
              ? t('chatFormLookupChosenLabel', { label, record: recordName(t, chosen) })
              : t('chatFormLookupEmptyLabel', { label })
          }
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <span>{chosen ? recordName(t, chosen) : t('chatFormLookupChoose', { label })}</span>
          <IconSearch size={16} aria-hidden="true" />
        </button>
        {chosen && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChoose(undefined)}>
            {t('chatFormLookupClear')}
          </Button>
        )}
      </span>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('chatFormLookupTitle', { label })}
        closeLabel={t('chatFormLookupClose')}
        className="oryh-chat-lookup-card"
      >
        <div className="oryh-chat-lookup-dialog">
          <Input
            data-modal-autofocus
            aria-label={t('chatFormLookupInputLabel')}
            placeholder={t('chatFormLookupPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          <ul aria-label={t('chatFormLookupResults')}>
            {/* The list keeps its height while it is empty, so the dialog does not jump as results come and go. */}
            {(found?.rows.length ?? 0) === 0 && (
              <li className="oryh-chat-lookup-empty">{note || t('chatFormLookupPrompt')}</li>
            )}
            {(found?.rows ?? []).map(record => (
              <li key={record.id}>
                <button
                  type="button"
                  aria-current={chosen?.id === record.id ? 'true' : undefined}
                  onClick={() => {
                    onChoose(record)
                    setOpen(false)
                  }}
                >
                  <strong>{record.name}</strong>
                  <span>{record.code}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="oryh-chat-lookup-foot">
            <span role="status">
              {found?.rows.length
                ? note || t('chatFormLookupCount', { total: found.total, listed: found.rows.length })
                : ''}
            </span>
            {found && found.page < found.pages && (
              <Button size="sm" variant="outline" onClick={() => load(query.trim(), found.page + 1)}>
                {t('chatFormLookupMore')}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}

type Line = Record<string, string | boolean>
type State = { values: Line; lines: Record<string, Line[]> }

const numeric = (value: unknown): number =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.replaceAll(',', ''))
      : Number.NaN

/** A field's starting value: what the agent filled in ahead, or nothing. */
function initial(field: CustomFormField, given: unknown): string | boolean {
  if (field.type === 'checkbox') return given === true
  // A record is chosen from ORYH here, with its name; an id handed in ahead would show as nothing.
  if (field.type === 'product' || field.type === 'record') return ''
  return given === undefined || given === null || typeof given === 'object' ? '' : String(given)
}

function start(shown: ChatFormShown): State {
  const values: Line = {}
  const lines: Record<string, Line[]> = {}
  for (const field of shown.form.fields) {
    const given = shown.values[field.name]
    if (field.type !== 'lines') {
      values[field.name] = initial(field, given)
      continue
    }
    const columns = field.fields ?? []
    const blank = () => Object.fromEntries(columns.map(column => [column.name, initial(column, undefined)]))
    const filled = Array.isArray(given)
      ? given.map(line =>
          Object.fromEntries(columns.map(column => [column.name, initial(column, line?.[column.name])])),
        )
      : []
    while (filled.length < Math.max(field.min ?? 0, 1)) filled.push(blank())
    lines[field.name] = filled.slice(0, field.max ?? 50)
  }
  return { values, lines }
}

function lineFigure(line: Line, item: CustomComputed): number {
  if (item.zeroWhen && line[item.zeroWhen] === true) return 0
  if (!item.multiply) return Number.NaN
  return numeric(line[item.multiply[0]]) * numeric(line[item.multiply[1]])
}

/** The forms of one completed turn; nothing for a turn that showed none. */
export function ChatForms({
  t,
  turn,
  useForms,
  submit,
  records,
}: PropsRuntime<'conversation.chat.turnTail'> & InjectFace<ChatFormsInjected> & { t: Words }): ReactNode {
  const forms = useForms(String(turn.turn))
  const shown = (forms ?? []).filter(form => !form.failed)
  if (shown.length === 0) return null
  return (
    <div className="oryh-chat-forms">
      {shown.map(form => (
        <ChatFormCard key={form.callId} t={t} shown={form} submit={submit} records={records} />
      ))}
    </div>
  )
}

function ChatFormCard({
  t,
  shown,
  submit,
  records,
}: {
  t: Words
  shown: ChatFormShown
  submit: ChatFormsInjected['submit']
  records: ChatFormsInjected['records']
}): ReactNode {
  const { form, data } = shown
  const [state, setState] = useState(() => start(shown))
  const [status, setStatus] = useState<{ kind: 'pending' | 'sent' | 'error'; message: string }>()
  // What was chosen in the record fields, by where each looks and the id the form holds: a field shows a
  // name, and holds an id.
  const [picked, setPicked] = useState<Record<string, Chosen>>({})
  const sent = shown.submitted || status?.kind === 'sent'
  if (sent)
    return (
      <div className="oryh-chat-form" data-state="sent" role="status">
        <strong>{form.label}</strong>
        <span>{status?.kind === 'sent' ? status.message : t('chatFormSubmitted')}</span>
      </div>
    )
  const busy = status?.kind === 'pending'
  const setValue = (name: string, value: string | boolean) =>
    setState(current => ({ ...current, values: { ...current.values, [name]: value } }))
  const setLines = (name: string, change: (lines: Line[]) => Line[]) =>
    setState(current => ({ ...current, lines: { ...current.lines, [name]: change(current.lines[name] ?? []) } }))
  const input = (
    id: string,
    field: CustomFormField,
    value: string | boolean,
    onChange: (value: string | boolean) => void,
  ): ReactNode => {
    switch (field.type) {
      case 'checkbox':
        return <Checkbox checked={value === true} label={field.label} disabled={busy} onChange={onChange} />
      case 'record':
      case 'product': {
        const lookup = lookupOf(field)
        // A record field with nowhere to look is not one the Host would have shown.
        if (!lookup) return null
        const key = lookupKey(lookup)
        return (
          <RecordField
            t={t}
            label={field.label}
            chosen={typeof value === 'string' && value ? picked[`${key}|${value}`] : undefined}
            disabled={busy}
            search={(query, page) => records(lookup, query, page)}
            onChoose={record => {
              if (record) setPicked(current => ({ ...current, [`${key}|${record.id}`]: record }))
              onChange(record?.id ?? '')
            }}
          />
        )
      }
      case 'textarea':
        return (
          <textarea
            id={id}
            aria-label={field.label}
            disabled={busy}
            value={String(value)}
            onChange={event => onChange(event.target.value)}
          />
        )
      case 'select':
        return (
          <select
            id={id}
            aria-label={field.label}
            disabled={busy}
            value={String(value)}
            onChange={event => onChange(event.target.value)}
          >
            <option value="">{t('formChoose')}</option>
            {formChoices(field, data).map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )
      default:
        return (
          <Input
            id={id}
            aria-label={field.label}
            disabled={busy}
            type={field.type === 'date' ? 'date' : 'text'}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            value={String(value)}
            onChange={event => onChange(event.target.value)}
          />
        )
    }
  }
  const labelled = (key: string, field: CustomFormField, control: ReactNode) => (
    <label key={key} className="oryh-chat-field" data-type={field.type}>
      {field.type !== 'checkbox' && (
        <span>
          {field.label}
          {field.required ? ' *' : ''}
        </span>
      )}
      {control}
    </label>
  )
  const sums: Record<string, number> = {}
  for (const field of form.fields) {
    if (field.type !== 'lines') continue
    for (const line of state.lines[field.name] ?? []) {
      for (const item of field.computed ?? []) {
        const value = lineFigure(line, item)
        if (Number.isFinite(value))
          sums[`${field.name}.${item.name}`] = (sums[`${field.name}.${item.name}`] ?? 0) + value
      }
      for (const column of field.fields ?? []) {
        const value = column.type === 'number' ? numeric(line[column.name]) : Number.NaN
        if (Number.isFinite(value))
          sums[`${field.name}.${column.name}`] = (sums[`${field.name}.${column.name}`] ?? 0) + value
      }
    }
  }
  async function send() {
    if (busy) return
    setStatus({ kind: 'pending', message: t('chatFormSubmitting') })
    try {
      const message = await submit(shown, { ...state.values, ...state.lines })
      setStatus({ kind: 'sent', message })
    } catch (reason) {
      setStatus({ kind: 'error', message: reason instanceof Error ? reason.message : t('chatFormSubmitFailed') })
    }
  }
  return (
    <form
      className="oryh-chat-form"
      aria-label={form.label}
      onSubmit={event => {
        event.preventDefault()
        void send()
      }}
    >
      <strong>{form.label}</strong>
      {form.fields.map(field => {
        if (field.type !== 'lines')
          return labelled(
            field.name,
            field,
            input(`${shown.callId}-${field.name}`, field, state.values[field.name] ?? '', value =>
              setValue(field.name, value),
            ),
          )
        const lines = state.lines[field.name] ?? []
        const columns = field.fields ?? []
        return (
          <fieldset key={field.name} className="oryh-chat-lines">
            <legend>
              {field.label}
              {field.required ? ' *' : ''}
            </legend>
            {lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a line has no identity but its place.
              <div className="oryh-chat-line" key={index}>
                <div className="oryh-chat-line-head">
                  <span>{t('chatFormLineNumber', { number: index + 1 })}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || lines.length <= Math.max(field.min ?? 0, 1)}
                    onClick={() => setLines(field.name, all => all.filter((_, i) => i !== index))}
                  >
                    {t('formLineRemove')}
                  </Button>
                </div>
                <div className="oryh-chat-line-fields">
                  {columns.map(column =>
                    labelled(
                      column.name,
                      column,
                      input(
                        `${shown.callId}-${field.name}-${index}-${column.name}`,
                        column,
                        line[column.name] ?? '',
                        value =>
                          setLines(field.name, all =>
                            all.map((current, i) => {
                              if (i !== index) return current
                              const next: Line = { ...current, [column.name]: value }
                              // A choice with defaults brings its own along: a product, its price.
                              if (column.type === 'select' && column.defaults) {
                                const chosen = formChoices(column, data).find(option => option.value === value)
                                for (const [target, source] of Object.entries(column.defaults)) {
                                  const given = chosen?.item?.[source]
                                  if (given !== undefined && given !== null) next[target] = formatValue(given)
                                }
                              }
                              return next
                            }),
                          ),
                      ),
                    ),
                  )}
                </div>
                {(field.computed ?? []).map(item => {
                  const value = lineFigure(line, item)
                  return Number.isFinite(value) ? (
                    <output key={item.name}>
                      {item.label} {formatValue(value, 'number')}
                    </output>
                  ) : null
                })}
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || lines.length >= (field.max ?? 50)}
              onClick={() =>
                setLines(field.name, all => [
                  ...all,
                  Object.fromEntries(columns.map(column => [column.name, initial(column, undefined)])),
                ])
              }
            >
              {t('formLineAdd')}
            </Button>
          </fieldset>
        )
      })}
      {(form.computed ?? []).map(item =>
        item.sum && Number.isFinite(sums[item.sum]) ? (
          <output key={item.name} className="oryh-chat-total">
            {item.label} {formatValue(sums[item.sum], 'number')}
          </output>
        ) : null,
      )}
      <div className="oryh-chat-form-actions">
        <Button variant="primary" size="sm" type="submit" disabled={busy}>
          {t('chatFormSubmit')}
        </Button>
        <span data-kind={status?.kind ?? 'idle'} role="status">
          {status?.message ?? t('chatFormSubmitHint')}
        </span>
      </div>
    </form>
  )
}
