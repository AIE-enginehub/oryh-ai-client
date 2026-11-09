import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { type ComponentProps, type SetStateAction, useCallback } from 'react'
import { columnPreferenceScope } from './column-preferences.js'

/**
 * What a stored preference is checked with before a view sees it. The shape zod's schemas have, so one
 * can be passed where a preference needs more than the few kept here — but written out by hand for
 * these: this library is bundled into every page plugin, and a schema library for seven small checks
 * would be carried by each of them.
 */
export interface PreferenceSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}
/** A check that never fails: what does not fit reads as `fallback`. */
function lenient<T>(read: (value: unknown) => T | undefined, fallback: T): PreferenceSchema<T> {
  return { safeParse: value => ({ success: true, data: read(value) ?? fallback }) }
}
const text = (max: number) => (value: unknown) => (typeof value === 'string' && value.length <= max ? value : undefined)
const FIELD_NAME = /^[a-z_][a-z0-9_]{0,63}$/
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const textPreference = lenient(text(2000), '')
export const pagePreference = lenient(
  value => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000000 ? value : undefined),
  1,
)
export const booleanPreference = lenient(value => (typeof value === 'boolean' ? value : undefined), false)
export const filterPreference = lenient(
  value =>
    isObject(value)
      ? {
          text: text(2000)(value.text) ?? '',
          status: text(2000)(value.status) ?? '',
          from: text(2000)(value.from) ?? '',
          to: text(2000)(value.to) ?? '',
          descending: typeof value.descending === 'boolean' ? value.descending : true,
        }
      : undefined,
  { text: '', status: '', from: '', to: '', descending: true },
)
export const productPreference = lenient<{ id: string; name: string; code: string }[]>(value => {
  if (!Array.isArray(value) || value.length > 50) return undefined
  const products = []
  for (const item of value) {
    if (!isObject(item)) return undefined
    const id = text(200)(item.id),
      name = text(1000)(item.name),
      code = text(1000)(item.code)
    if (id === undefined || name === undefined || code === undefined) return undefined
    products.push({ id, name, code })
  }
  return products
}, [])
// Field names only. Which fields a list really accepts is the deployment's answer, checked when the page
// loads them — this check must not decide it, or it becomes one more hardcoded list.
export const queryFieldsPreference = lenient<string[]>(
  value =>
    Array.isArray(value) && value.length <= 20 && value.every(v => typeof v === 'string' && FIELD_NAME.test(v))
      ? [...new Set(value as string[])]
      : undefined,
  [],
)
/** Query-field values keyed by field name; empty values are dropped rather than sent. */
export const queryValuesPreference = lenient<Record<string, string>>(
  value =>
    isObject(value) && Object.entries(value).every(([key, v]) => FIELD_NAME.test(key) && text(200)(v) !== undefined)
      ? (value as Record<string, string>)
      : undefined,
  {},
)

export function createViewPreference<T>(
  scope: string | undefined,
  key: string,
  initial: T,
  schema: PreferenceSchema<T>,
) {
  const store = createSnapshotStore<T>(
    initial,
    scope === undefined ? undefined : { persist: { name: `oryh.view.v1:${scope}:${key}` } },
  )
  const normalize = (value: unknown): T => {
    const result = schema.safeParse(value)
    return result.success ? result.data : initial
  }
  store.set(normalize(store.getSnapshot()))
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    set: (next: SetStateAction<T>) =>
      store.set(normalize(typeof next === 'function' ? (next as (v: T) => T)(store.getSnapshot()) : next)),
  }
}
/** One kept preference: a source to read, and the one way to change it. */
export interface PreferenceStore {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
  // biome-ignore lint/suspicious/noExplicitAny: each store checks what it is given; the registry holds them all.
  set(next: any): void
}
/**
 * The frame plugin's registry of kept preferences, as a page reaches it: one store per stored name,
 * whoever asks. Two components — or a page and its bridge — that name the same preference hold the same
 * store, which two stores over one stored key never were.
 */
export interface Preferences {
  /** Make the store for a name if nobody has yet. */
  open(name: string, make: () => PreferenceStore): void
  set(name: string, next: unknown): void
  get(name: string): unknown
}
/** What the preference hooks read of a page's face. */
export interface PreferenceFace {
  connection: ConnectionSummary
  prefs: Preferences
  frame: {
    /** The renderer's hook over the registry: the value kept under a name, or undefined before it is opened. */
    usePreference: (name: string) => unknown
  }
}

/**
 * One preference of a view, kept for the enterprise identity the page is drawn for.
 * @param face - what the page's slot handed it.
 */
export function useViewPreference<T>(face: PreferenceFace, key: string, initial: T, schema: PreferenceSchema<T>) {
  const scope = columnPreferenceScope(face.connection)
  const name = `oryh.view.v1:${scope}:${key}`
  const { prefs } = face
  prefs.open(name, () => createViewPreference(scope, key, initial, schema))
  const value = (face.frame.usePreference(name) ?? prefs.get(name)) as T
  const set = useCallback((next: SetStateAction<T>) => prefs.set(name, next), [prefs, name])
  return [value, set] as const
}
export function PreferenceDetails({
  face,
  preferenceKey,
  ...props
}: ComponentProps<'details'> & { face: PreferenceFace; preferenceKey: string }) {
  const [open, setOpen] = useViewPreference(face, preferenceKey, false, booleanPreference)
  return (
    <details
      {...props}
      open={open}
      onToggle={e => {
        setOpen(e.currentTarget.open)
        props.onToggle?.(e)
      }}
    />
  )
}
