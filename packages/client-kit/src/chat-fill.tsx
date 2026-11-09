/**
 * What the agent changed on a form, kept so the person can see it and take it back.
 *
 * A fill from Chat used to land as a sentence above the form at best — "filled from Chat, not yet
 * saved" — and on the project form as nothing at all: the values simply changed. Which fields, from
 * what to what, was for the person to work out, and the only way back was to discard the whole form.
 * A page now records each fill as it applies it: the fields that changed are marked until someone
 * edits them, a line above the form says what changed, and one button takes that fill back wherever
 * the person has not since typed something of their own (docs/13 §5, docs/56 §14).
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatActivity } from './chat-context.js'
import { Button, Notice } from './controls.js'
import type { OryhText } from './locale.js'

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The places two versions of a form differ, as dotted paths: `title`, `items.0.amount`.
 *
 * The rows two lists share are compared row by row, and a row past the end of the old list is one
 * place, the row itself: it was added, and taking the fill back takes it away again. A list that got
 * shorter is the list itself: which rows went has no good answer.
 * @param before - the form before the fill.
 * @param after - the form as the fill left it.
 */
export function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (same(before, after)) return []
  const at = (key: string | number) => (prefix ? `${prefix}.${key}` : String(key))
  if (Array.isArray(before) && Array.isArray(after) && before.length <= after.length)
    return [
      ...before.flatMap((item, index) => changedPaths(item, after[index], at(index))),
      ...after.slice(before.length).map((_, offset) => at(before.length + offset)),
    ]
  if (isRecord(before) && isRecord(after))
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
      changedPaths(before[key], after[key], at(key)),
    )
  return [prefix]
}

/** The value at a dotted path, or undefined where the path leads nowhere. */
export function valueAt(value: unknown, path: string): unknown {
  let current = value
  for (const key of path === '' ? [] : path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** A copy of a form with the value at a dotted path replaced; the original is left as it was. */
export function withValueAt<F>(value: F, path: string, replacement: unknown): F {
  if (path === '') return replacement as F
  const [head, ...rest] = path.split('.') as [string, ...string[]]
  const inner = withValueAt((value as Record<string, unknown> | undefined)?.[head], rest.join('.'), replacement)
  if (Array.isArray(value)) {
    const copy = [...value]
    copy[Number(head)] = inner
    return copy as F
  }
  return { ...(value as Record<string, unknown>), [head]: inner } as F
}

/** A copy of a form without the row at a dotted path; a path that is no row of a list changes nothing. */
function withoutRowAt<F>(value: F, path: string): F {
  const cut = path.lastIndexOf('.')
  const parent = cut < 0 ? '' : path.slice(0, cut)
  const index = Number(path.slice(cut + 1))
  const list = valueAt(value, parent)
  return Array.isArray(list)
    ? withValueAt(
        value,
        parent,
        list.filter((_, i) => i !== index),
      )
    : value
}
/** Whether a path names a row the fill added: nothing was there before, in a list that was. */
function addedRow(before: unknown, path: string): boolean {
  if (valueAt(before, path) !== undefined || !path.includes('.')) return false
  return Array.isArray(valueAt(before, path.slice(0, path.lastIndexOf('.'))))
}

/** One change of a fill, for the summary. */
export interface FillChange {
  path: string
  before: unknown
  after: unknown
  /** The change is a row the fill added to a list. */
  added?: true
}

/** What a page holds of the agent's last fill. */
export interface ChatFill<F> {
  /** Record a fill as it is applied: the form as it was, and as the agent made it. */
  record(before: F, after: F): void
  /** Forget the fill: the form was saved, discarded or replaced by another document. */
  clear(): void
  /** The places the agent filled that still hold what it put there. An edit by the person unmarks its field. */
  filled: ReadonlySet<string>
  /** What the fill changed and still stands, for the line above the form. */
  changes: readonly FillChange[]
  /**
   * The form with the fill taken back wherever the person has not typed over it since; undefined when
   * nothing of the fill is left to take back.
   */
  undone(): F | undefined
  /**
   * The agent that made the fill is still at work in the same turn. More of the form may follow, so it is
   * not yet for saving or sending: a page holds those buttons while this is so. Typing stays open — what
   * the person types is kept by the next fill — and a turn that stops to ask them something lets go.
   */
  writing: boolean
}

/**
 * Keep the agent's last fill of a form.
 * @param activity - what the agent of the pane's session is doing, from the page's `frame`.
 * @param current - the form as it is now, on every render.
 */
export function useChatFill<F>(activity: ChatActivity, current: F): ChatFill<F> {
  const [fill, setFill] = useState<{ before: F; after: F; paths: string[] }>()
  const standing = useMemo(
    () => (fill ? fill.paths.filter(path => same(valueAt(current, path), valueAt(fill.after, path))) : []),
    [fill, current],
  )
  // Whether the fill landed in a turn the agent has not finished. Read through a ref: a page's command
  // handler may hold a `record` from an earlier render.
  const running = useRef(activity === 'running')
  running.current = activity === 'running'
  const [inTurn, setInTurn] = useState(false)
  useEffect(() => {
    if (activity !== 'running') setInTurn(false)
  }, [activity])
  return {
    record: (before, after) => {
      const paths = changedPaths(before, after)
      setFill(paths.length ? { before, after, paths } : undefined)
      setInTurn(running.current)
    },
    clear: () => {
      setFill(undefined)
      setInTurn(false)
    },
    filled: useMemo(() => new Set(standing), [standing]),
    changes: fill
      ? standing.map(path => ({
          path,
          before: valueAt(fill.before, path),
          after: valueAt(fill.after, path),
          ...(addedRow(fill.before, path) ? { added: true as const } : {}),
        }))
      : [],
    undone: () => {
      if (!fill || standing.length === 0) return undefined
      const rows = standing.filter(path => addedRow(fill.before, path))
      const restored = standing
        .filter(path => !rows.includes(path))
        .reduce((form, path) => withValueAt(form, path, valueAt(fill.before, path)), current)
      // Added rows go last row first, so taking one away does not move the next one to go.
      return rows
        .map(path => ({ path, index: Number(path.slice(path.lastIndexOf('.') + 1)) }))
        .sort((a, b) => b.index - a.index)
        .reduce((form, row) => withoutRowAt(form, row.path), restored)
    },
    writing: inTurn && activity === 'running',
  }
}

/** Whether a place on the form, or anything under it, still holds what the agent filled. */
export function isFilled(fill: Pick<ChatFill<unknown>, 'filled'>, path: string): boolean {
  if (fill.filled.has(path)) return true
  for (const filled of fill.filled) if (filled.startsWith(`${path}.`) || path.startsWith(`${filled}.`)) return true
  return false
}

/** The attribute a field's wrapper carries while it holds what the agent filled; styles.css marks it. */
export function filledMark(fill: Pick<ChatFill<unknown>, 'filled'>, path: string): { 'data-ai-filled'?: true } {
  return isFilled(fill, path) ? { 'data-ai-filled': true } : {}
}

/**
 * The marks of a list's rows, where a row has an element of its own: an added row, or a list replaced
 * whole, marks the row; a field changed in a row that was there marks the field. One mark per change,
 * rather than a row's and each of its fields' at once.
 * @param list - the list's path, e.g. `items`.
 */
export function rowMarks(
  fill: Pick<ChatFill<unknown>, 'filled'>,
  list: string,
): {
  row(index: number): { 'data-ai-filled'?: true }
  field(index: number, name: string): { 'data-ai-filled'?: true }
} {
  const on = (path: string) => (fill.filled.has(path) ? ({ 'data-ai-filled': true } as const) : {})
  return {
    row: index => (fill.filled.has(list) ? { 'data-ai-filled': true } : on(`${list}.${index}`)),
    field: (index, name) => on(`${list}.${index}.${name}`),
  }
}

const shown = (t: OryhText, value: unknown): string => {
  if (value === undefined || value === null || value === '') return t('fillEmpty')
  if (typeof value === 'boolean') return value ? t('fillYes') : t('fillNo')
  if (Array.isArray(value)) return t('fillRows', { count: value.length })
  if (typeof value === 'object') return t('fillHasContent')
  const text = String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/**
 * The line above a form the agent filled: what it changed, and a way to take that back.
 * @param t - the frame's words.
 * @param fill - the page's record of the fill.
 * @param label - what a path is called to a person, e.g. `items.0.amount` as 「明细 1 金额」.
 * @param format - a value as the form shows it, where that is not the value itself: a choice's name
 *   rather than its code. Undefined leaves the value as it is.
 * @param onUndo - given the form with the fill taken back; the page puts it in place.
 * @param children - what the page adds after the changes, such as "not yet saved".
 */
export function ChatFillNote<F>({
  t,
  fill,
  label,
  format,
  onUndo,
  children,
}: {
  t: OryhText
  fill: ChatFill<F>
  label: (path: string) => string
  format?: (path: string, value: unknown) => string | undefined
  onUndo: (form: F) => void
  children?: ReactNode
}): ReactNode {
  if (fill.changes.length === 0 && !fill.writing) return null
  const listed = fill.changes.slice(0, 6)
  const said = (path: string, value: unknown) =>
    value === undefined || value === null || value === '' ? shown(t, value) : (format?.(path, value) ?? shown(t, value))
  return (
    <Notice
      intent="info"
      className="chat-fill-note"
      {...(fill.changes.length > 0
        ? {
            actions: (
              <Button
                size="sm"
                onClick={() => {
                  const form = fill.undone()
                  if (form !== undefined) onUndo(form)
                  fill.clear()
                }}
              >
                {t('fillUndo')}
              </Button>
            ),
          }
        : {})}
    >
      {fill.changes.length > 0 && (
        <>
          {t('fillSummary', { count: fill.changes.length })}
          {listed
            .map(change =>
              change.added
                ? t('fillAdded', { label: label(change.path) })
                : t('fillChanged', {
                    label: label(change.path),
                    before: said(change.path, change.before),
                    after: said(change.path, change.after),
                  }),
            )
            .join(t('fillJoin'))}
          {fill.changes.length > listed.length ? t('fillMore') : ''}
          {t('fillEnd')}
          {children}
        </>
      )}
      {fill.writing && <span className="chat-fill-writing">{t('fillWriting')}</span>}
    </Notice>
  )
}
