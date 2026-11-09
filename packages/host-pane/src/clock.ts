/**
 * What day it is for the person a session belongs to.
 *
 * The model has no clock, and ORYH answers in UTC. Left to itself the agent took "today" from whatever
 * a page or a record happened to show, and with nothing to read it guessed: asked for this week's
 * timesheets it answered, sure of itself, for a week a fortnight gone (docs/55 §6). A due time the page
 * showed as 17:00 it read out as 09:00 UTC. So the Host says what day it is, in the zone of the browser
 * the person works in, and every tool that needs "today" takes it from here rather than from the Host's
 * own clock, which in a container is UTC.
 */

/** One reading of a session's clock. */
export interface Clock {
  /** IANA zone the reading is in, e.g. `Asia/Shanghai`. */
  timeZone: string
  /** Where the zone came from: the person's browser, or the deployment while no browser has said. */
  source: 'browser' | 'deployment'
  /** The calendar day there, `YYYY-MM-DD`. */
  today: string
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  weekday: number
  /** The zone's offset from UTC at this moment, e.g. `+08:00`. */
  offset: string
  /** The moment itself as that zone writes it, to the second: `2026-10-07T09:16:05+08:00`. */
  now: string
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * A time zone a browser reported, if it is one this runtime can keep time in.
 * @param value - what arrived on the wire.
 * @returns the zone, or undefined for anything that is not a usable IANA name.
 */
export function timeZoneOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value
  } catch {
    return undefined
  }
}

/**
 * The zone a deployment keeps time in while no browser has reported one: `ORYH_TIME_ZONE` when it names
 * a zone, else the Host process's own.
 */
export function deploymentTimeZone(env: Record<string, string | undefined> = process.env): string {
  return timeZoneOf(env.ORYH_TIME_ZONE?.trim()) ?? new Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Read the clock in one zone.
 * @param timeZone - a zone {@link timeZoneOf} accepted.
 * @param source - where that zone came from.
 * @param at - the moment to read; now when omitted.
 * @returns the day, weekday, offset and moment there.
 */
export function readClock(timeZone: string, source: Clock['source'], at: Date = new Date()): Clock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    timeZoneName: 'longOffset',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? ''
  const today = `${part('year')}-${part('month')}-${part('day')}`
  // `GMT+08:00`, `GMT-03:30`, and a bare `GMT` for UTC itself.
  const offset = part('timeZoneName').replace(/^GMT/, '') || '+00:00'
  return {
    timeZone,
    source,
    today,
    weekday: WEEKDAYS.indexOf(part('weekday')) + 1,
    offset,
    now: `${today}T${part('hour')}:${part('minute')}:${part('second')}${offset}`,
  }
}
