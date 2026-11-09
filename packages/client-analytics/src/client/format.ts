import type { CustomFormat } from '@oryh/dsh-analytics/types'

/** A value as the page writes it; the same rules as a framed page's. */
export function formatValue(value: unknown, format?: CustomFormat | string): string {
  if (value === null || value === undefined) return ''
  const number = Number(value)
  const numeric =
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(number))
  if (numeric && format === 'number') return number.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
  if (numeric && format === 'money')
    return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (numeric && format === 'percent') return `${(number * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
  if (format === 'date' && typeof value === 'string') return day(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
const ZONED_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
/**
 * The day a value falls on in the person's calendar; a framed page's `day` is its twin. A timestamp with
 * a zone is a moment, and cutting its first ten characters gives UTC's day, a day off from what the other
 * pages and the agent say for part of every day. A plain date or a zoneless time names its own day.
 */
function day(value: string): string {
  const match = ZONED_TIME.exec(value)
  if (!match) return value.slice(0, 10)
  const moment = new Date(value)
  if (!match[2] || Number.isNaN(moment.getTime())) return match[1]!
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`
}
