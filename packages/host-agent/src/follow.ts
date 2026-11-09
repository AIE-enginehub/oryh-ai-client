/** Reading what the agent asked of ORYH, so the pane can follow it. */

const MAX_RESULT_BYTES = 2_000_000

/**
 * Which ORYH resource a tool call is about, whatever the tool's parameters are called.
 *
 * The server offers several tools over the same REST surface — `oryh_request`, `oryh_list`,
 * `oryh_get`, `oryh_detail` — and adds more over time, so matching one tool's parameter names would
 * quietly stop working the moment the agent picks another. Every string in the arguments is read as a
 * possible path instead, and the first one that names a resource some page shows wins.
 * @param args - the call's arguments.
 * @param known - whether a resource name is one a page shows.
 */
export function resourceOf(args: unknown, known: (resource: string) => boolean, depth = 0): string | undefined {
  if (typeof args === 'string') {
    const bare = args
      .split('?')[0]!
      .replace(/^\/api\/v1(?=\/|$)/, '')
      .replace(/^\//, '')
    const first = bare.split('/')[0]
    return first && known(first) ? first : undefined
  }
  if (depth > 2 || !args || typeof args !== 'object') return undefined
  for (const value of Object.values(args as Record<string, unknown>)) {
    const found = resourceOf(value, known, depth + 1)
    if (found) return found
  }
  return undefined
}

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Every string in a call's arguments, to the depth a tool's parameters go. */
function strings(args: unknown, depth = 0): string[] {
  if (typeof args === 'string') return [args]
  if (depth > 2 || !args || typeof args !== 'object') return []
  return Object.values(args as Record<string, unknown>).flatMap(value => strings(value, depth + 1))
}

/**
 * The one record of a resource a call names.
 *
 * By its path where there is one — `/sales-orders/<id>`, `/sales-orders/<id>/detail` — since a detail
 * answers with the document and its tables and not always with an `id` of its own. ORYH's `oryh_get` and
 * `oryh_detail` take the collection and the id as two parameters instead; for a call that only read, an
 * id standing alone among the arguments is that record, provided it is the only one there. A write is
 * not read this way: its body carries the ids of other things — a customer, a product — and one of those
 * taken for the record would open nothing.
 * @param args - the call's arguments.
 * @param resource - the resource the call is about, as {@link resourceOf} found it.
 * @param loose - also take a lone id among the arguments; for calls that only read.
 */
export function recordIdOf(args: unknown, resource: string, loose = false): string | undefined {
  const found = strings(args)
  for (const value of found) {
    const [first, second] = value
      .split('?')[0]!
      .replace(/^\/api\/v1(?=\/|$)/, '')
      .replace(/^\//, '')
      .split('/')
    if (first === resource && second !== undefined && RECORD_ID.test(second)) return second
  }
  if (!loose) return undefined
  const ids = [...new Set(found.filter(value => RECORD_ID.test(value)))]
  return ids.length === 1 ? ids[0] : undefined
}

/**
 * What ORYH answered, as far as the pane cares: a list to show, or one record and its id. A list that
 * came back with a single row names that row as `only`: looked up by its number, a document arrives
 * as a list of one, and it is the document the agent goes on to talk about.
 *
 * One row because the read asked for a page of one is not that. An agent counting reads a single row and
 * takes the total, and the pane then opened that row — asked how many orders were confirmed, it showed
 * the first of four. Where ORYH says how many there are in all, `only` is the row of a list of one.
 */
export function answerShape(text: string): { list: boolean; id?: string; only?: string } {
  if (text.length > MAX_RESULT_BYTES) return { list: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { list: false }
  }
  const data = (parsed as { data?: unknown })?.data
  if (Array.isArray(data)) {
    const total = (parsed as { meta?: { total?: unknown } })?.meta?.total
    const alone = data.length === 1 && (typeof total !== 'number' || total === 1)
    const only = alone ? (data[0] as { id?: unknown } | null)?.id : undefined
    return { list: true, ...(typeof only === 'string' && only ? { only } : {}) }
  }
  const id = (data as { id?: unknown })?.id
  return { list: false, ...(typeof id === 'string' && id ? { id } : {}) }
}

const COLLECTION = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * The record a write was about, for a page to point out: its collection and its id.
 *
 * The collection is the first segment of the call's path, whatever page there is or is not for it; the id
 * is the one ORYH answered with — what a create returns — or the one the path named. A write that names
 * no single record, such as a batch, names none here.
 * @param args - the call's arguments.
 * @param text - what ORYH answered.
 */
export function writtenRecord(args: unknown, text: string): { collection: string; id: string } | undefined {
  for (const value of strings(args)) {
    if (!value.startsWith('/')) continue
    const [collection, second] = value
      .split('?')[0]!
      .replace(/^\/api\/v1(?=\/|$)/, '')
      .replace(/^\//, '')
      .split('/')
    if (!collection || !COLLECTION.test(collection)) continue
    const id = second !== undefined && RECORD_ID.test(second) ? second : answerShape(text).id
    return id ? { collection, id } : undefined
  }
  return undefined
}

/** Parameters that say how much of a list to read and in what order, not which rows. */
const NOT_CONDITIONS = new Set([
  'page',
  'size',
  'page_size',
  'limit',
  'offset',
  'order_by',
  'sort',
  'include',
  'fields',
])

/**
 * The conditions a read narrowed its list by, so the pane can show the list the same way.
 *
 * ORYH's tools carry them as an object — `filters` on `oryh_list`, `query` on `oryh_request` — or in
 * the path's own query string. Paging and ordering are left out: they say how much to read, not what.
 * @param args - the call's arguments.
 * @returns condition name to value, as text; empty when the read was not narrowed.
 */
export function conditionsOf(args: unknown): Record<string, string> {
  const conditions: Record<string, string> = {}
  if (!args || typeof args !== 'object') return conditions
  const take = (name: string, value: unknown) => {
    if (NOT_CONDITIONS.has(name) || !/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(name)) return
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return
    const text = String(value).trim()
    if (text && text.length <= 200 && (name in conditions || Object.keys(conditions).length < 10))
      conditions[name] = text
  }
  const record = args as Record<string, unknown>
  for (const value of Object.values(record))
    if (typeof value === 'string' && value.includes('?'))
      for (const [name, text] of new URLSearchParams(value.slice(value.indexOf('?') + 1))) take(name, text)
  for (const key of ['filters', 'query', 'params']) {
    const held = record[key]
    if (held && typeof held === 'object' && !Array.isArray(held))
      for (const [name, value] of Object.entries(held)) take(name, value)
  }
  return conditions
}

/**
 * Whether a call names one record, anywhere in its arguments — a path, a body field, a filter.
 * @param args - the call's arguments.
 * @param id - the record's id; an empty id names nothing.
 */
export function mentions(args: unknown, id: string): boolean {
  if (!id) return false
  try {
    return JSON.stringify(args ?? null).includes(id)
  } catch {
    return false
  }
}
