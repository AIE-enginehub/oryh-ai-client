/**
 * A form that describes itself to the agent, and takes what the agent fills.
 *
 * The timesheet, project and expense forms are each wired into the pane bridge by name. A form that
 * uses this needs no wiring: it says what fields it has and what they hold, the page's owner reports
 * that with the page, and a fill from Chat comes back to it field by field (docs/56 §15). What the
 * person typed after the agent read the form is theirs: such a field is kept, and the agent is told.
 */
import type { PageId } from '@oryh/ai-client-pages'
import type { FormFieldSpec, FormValue, PaneFormContext } from '@oryh/dsh-pane/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type PaneFace, useCommand } from './pane.js'

type Values = Record<string, FormValue>
/** Whether two values of a field are the same: lines are lists, compared by what they hold. */
const same = (a: FormValue | undefined, b: FormValue | undefined) => JSON.stringify(a) === JSON.stringify(b)
/** What a field holds when the form has never held anything for it, in the kind the other side has. */
const blank = (like: FormValue | undefined): FormValue => (Array.isArray(like) ? [] : '')

/**
 * Apply a fill field by field. A field is set while it still holds what the agent read, or already
 * holds what the agent wants; one the person has changed since is left as they have it. Lines are one
 * field: a row the person added, removed or typed in since keeps all of them as they are.
 * @param current - the form now.
 * @param base - what the agent read, for the fields it fills.
 * @param values - what the agent fills.
 * @returns the form after the fill, and which fields were applied and which kept.
 */
export function applyFields(
  current: Values,
  base: Values,
  values: Values,
): { next: Values; applied: string[]; kept: string[] } {
  const next = { ...current }
  const applied: string[] = []
  const kept: string[] = []
  for (const [name, value] of Object.entries(values)) {
    const now = current[name] ?? blank(value)
    if (same(now, base[name] ?? blank(value)) || same(now, value)) {
      next[name] = value
      applied.push(name)
    } else kept.push(name)
  }
  return { next, applied, kept }
}

interface Entry {
  spec: Omit<PaneFormContext, 'chat'>
  fill(values: Values, base: Values): { applied: string[]; kept: string[] }
}
/** Where a page's forms describe themselves; a page owner makes one and hands it to each form. */
export interface ChatFormRegistry {
  set(id: string, entry: Entry | undefined): void
}

/**
 * Collects a page's forms that describe themselves, reports them with the page, and hands each the
 * fills Chat sends for it. One per page owner.
 * @param face - what the page's slot handed it.
 * @param page - the page the forms are on, as the Host knows it.
 * @param active - whether that page is on screen; a hidden page takes no fill.
 * @param onForms - told the forms to report whenever they change.
 * @returns the registry the page hands to each form's {@link useChatForm}.
 */
export function useChatForms(
  face: PaneFace,
  {
    page,
    active,
    onForms,
  }: {
    page: PageId
    active: boolean
    onForms: (forms: PaneFormContext[]) => void
  },
): ChatFormRegistry {
  const entries = useRef(new Map<string, Entry>())
  const [version, setVersion] = useState(0)
  const [chats, setChats] = useState<Record<string, NonNullable<PaneFormContext['chat']>>>({})
  const registry = useMemo<ChatFormRegistry>(
    () => ({
      set: (id, entry) => {
        if (entry) entries.current.set(id, entry)
        else entries.current.delete(id)
        setVersion(current => current + 1)
      },
    }),
    [],
  )
  const report = useRef(onForms)
  report.current = onForms
  const reported = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` moves whenever an entry does.
  useEffect(() => {
    const forms = [...entries.current.entries()].map(([id, entry]) => ({
      ...entry.spec,
      ...(chats[id] ? { chat: chats[id] } : {}),
    }))
    const key = JSON.stringify(forms)
    if (key === reported.current) return
    reported.current = key
    report.current(forms)
  }, [version, chats])
  useCommand(
    face,
    'form',
    page,
    (payload, command) => {
      if (!active || payload.kind !== 'fields') return false
      const entry = entries.current.get(payload.form)
      // A form that is sending waits its turn; one that is gone cannot answer, and the Host's wait ends.
      if (!entry) return true
      if (entry.spec.busy) return false
      const result = entry.fill(payload.values, payload.base)
      setChats(current => ({ ...current, [payload.form]: { id: command.id, ...result } }))
      return true
    },
    [active, version],
  )
  return registry
}

/**
 * Describe a form to the agent, and take its fills. Without a registry this does nothing: the form
 * works as it always did, and Chat does not see it.
 * @param registry - the page owner's, from {@link useChatForms}.
 * @param form - the form, or undefined while it is not on screen: a page whose form opens and closes.
 * @param form.id - stable while the same form is on screen.
 * @param form.onFill - given the values after a fill; the form puts them in place.
 */
export function useChatForm(
  registry: ChatFormRegistry | undefined,
  form:
    | {
        id: string
        label: string
        fields: FormFieldSpec[]
        values: Values
        busy: boolean
        onFill: (next: Values) => void
      }
    | undefined,
): void {
  const latest = useRef(form)
  latest.current = form
  const described = form ? JSON.stringify([form.label, form.fields, form.values, form.busy]) : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: `described` is the form, serialised.
  useEffect(() => {
    if (!registry || !latest.current) return
    const { id, label, fields, values, busy } = latest.current
    registry.set(id, {
      spec: { id, label, fields, values, busy },
      fill: (filled, base) => {
        const now = latest.current
        if (!now) return { applied: [], kept: Object.keys(filled) }
        const { next, applied, kept } = applyFields(now.values, base, filled)
        if (applied.length) now.onFill(next)
        return { applied, kept }
      },
    })
    return () => registry.set(id, undefined)
  }, [registry, form?.id, described])
}
