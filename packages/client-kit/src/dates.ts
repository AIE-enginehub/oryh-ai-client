/**
 * How the workbench writes dates and times. No interface library here: the data modules that turn ORYH
 * rows into list rows format with these too, and must not pull one in to do it.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A date the way the workbench writes dates: `YYYY-MM-DD`, local time.
 * @param value - a Date, epoch milliseconds, or anything `Date` parses.
 * @returns the date, or the input unchanged when it is not one.
 */
export function formatDate(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A moment the way the workbench writes time: `YYYY-MM-DD HH:mm`, local time.
 * @param value - a Date, epoch milliseconds, or anything `Date` parses.
 * @returns the moment, or the input unchanged when it is not one.
 */
export function formatDateTime(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * Show a server value, writing an ISO timestamp as {@link formatDateTime} does.
 * Anything that is not an ISO timestamp — a plain date, a number, free text — comes back unchanged, so
 * this is safe to apply to every displayed value.
 * @param value - a displayed value.
 * @returns the formatted value.
 */
export function formatDisplayValue(value: string): string {
  const match = ISO_TIME.exec(value)
  if (!match) return value
  // Without a zone the server meant wall-clock time; keep it rather than shifting it through UTC.
  if (!match[4]) return `${match[1]} ${match[2]}:${match[3]}`
  return formatDateTime(value)
}

/**
 * The day a server value falls on in the person's calendar, `YYYY-MM-DD`.
 *
 * A timestamp with a zone is a moment, and which day it is depends on where the reader is. Cutting its
 * first ten characters gives UTC's day: a list then says the 3rd beside a detail, and an agent, that say
 * the 4th at two in the morning. A plain date, or a time the server wrote without a zone, names its own day.
 * @param value - a date or timestamp as the server sent it.
 * @returns the day, or the first ten characters of anything that is neither.
 */
export function formatDisplayDate(value: string): string {
  const match = ISO_TIME.exec(value)
  if (!match) return value.slice(0, 10)
  return match[4] ? formatDate(value) : match[1]!
}
