/**
 * Translate only built-in field/status vocabulary, never record text or tenant-authored labels.
 *
 * The lookups are keyed by the stable value the server uses (`submitted`, `order_no`, `items`), not by the
 * Chinese word shown on a Chinese page: a tenant label that happens to read 状态 is not translated, and a
 * change to a Chinese word does not silently take its English translation with it.
 */
import {
  fieldLabel,
  fieldWordsEn,
  isBuiltInFieldLabel,
  sectionLabel,
  sectionWordsEn,
  statusLabel,
  statusValue,
  statusWords,
  statusWordsEn,
} from '@oryh/ai-client-records'
import type { OryhText } from './locale.js'

const english = (t: OryhText): boolean => t('interfaceLanguage') === 'en'

/** A state as the API names it (`submitted`) in the person's language. */
export function displayStatus(t: OryhText, status: string): string {
  return english(t) && Object.hasOwn(statusWordsEn, status) ? statusWordsEn[status]! : statusLabel(status)
}

/**
 * A field as the API names it in the person's language. A label the tenant chose is shown as it is: the
 * built-in translation applies only when the label is still the built-in one for that field.
 */
export function displayField(t: OryhText, field: string, label = fieldLabel(field)): string {
  if (!english(t) || !isBuiltInFieldLabel(field, label)) return label
  return Object.hasOwn(fieldWordsEn, field) ? fieldWordsEn[field]! : label
}

/** A child table (`items`) in the person's language, under the same tenant-label rule as {@link displayField}. */
export function displaySection(t: OryhText, name: string, label = sectionLabel(name)): string {
  if (!english(t) || label !== sectionLabel(name)) return label
  return Object.hasOwn(sectionWordsEn, name) ? sectionWordsEn[name]! : label
}

/** A translated filter choice still sends ORYH its stable machine state. */
export function displayStatusValue(t: OryhText, typed: string): string {
  const value = typed.trim()
  const table = english(t) ? statusWordsEn : statusWords
  const entry = Object.entries(table).find(([, label]) => label.toLocaleLowerCase() === value.toLocaleLowerCase())
  return entry?.[0] ?? statusValue(value)
}
