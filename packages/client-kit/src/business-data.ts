import type { OryhOperationResult, OryhTodo } from '@oryh/ai-client-core'
import { type BusinessKey, type BusinessText, businessZh, defaultText } from './business-locales.js'
import { formatDisplayDate } from './dates.js'
export interface BusinessRow {
  id: string
  title: string
  status: string
  date: string
  secondary: string
  fields: [string, string][]
  entityType: string
  /** The ORYH document this row is about, where that is not the row itself: a todo's linked document. */
  subject?: { type: string; id: string }
}
export interface ViewFilter {
  text: string
  status: string
  from: string
  to: string
  descending: boolean
}
export const emptyFilter: ViewFilter = { text: '', status: '', from: '', to: '', descending: true }
/**
 * What a todo's document is called when ORYH gave it no title: the kind of document, in the person's
 * words. An `entity_type` this client has no word for shows as it came.
 */
export function entityTypeLabel(entityType: string, t: BusinessText = defaultText): string {
  const key = `entity_${entityType}`
  return Object.hasOwn(businessZh, key) ? t(key as BusinessKey) : entityType
}
export function businessRows(result: OryhOperationResult, t: BusinessText = defaultText): BusinessRow[] {
  return (result.result.data as readonly OryhTodo[]).map(row => ({
    id: row.id,
    title: row.title,
    status: row.status,
    // The person's day, as the detail beside it and the agent say it; not the first ten characters of a UTC time.
    date: row.dueAt ? formatDisplayDate(row.dueAt) : '',
    secondary: row.target?.title ?? entityTypeLabel(row.entityType, t),
    entityType: 'todo',
    subject: { type: row.entityType, id: row.entityId },
    fields: [
      [t('text78'), row.target?.title ?? entityTypeLabel(row.entityType, t)],
      [t('text183'), row.dueAt ?? t('text184')],
      [t('text136'), row.description ?? '—'],
      [t('text185'), row.target?.deleted ? t('text186') : '—'],
    ],
  }))
}
/** These filters apply only to the explicitly labelled loaded response, never an implied server-wide result. */
export function filterRows(rows: readonly BusinessRow[], filter: ViewFilter): BusinessRow[] {
  const query = filter.text.trim().toLocaleLowerCase()
  return rows
    .filter(
      row =>
        (!query ||
          `${row.title} ${row.secondary} ${row.fields.map(field => field[1]).join(' ')}`
            .toLocaleLowerCase()
            .includes(query)) &&
        (!filter.status || row.status === filter.status) &&
        (!filter.from || (row.date !== '' && row.date >= filter.from)) &&
        (!filter.to || (row.date !== '' && row.date <= filter.to)),
    )
    .sort((a, b) => {
      if (!a.date) return b.date ? 1 : 0
      if (!b.date) return -1
      return (filter.descending ? -1 : 1) * a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
    })
}
