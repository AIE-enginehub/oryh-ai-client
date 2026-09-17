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

/** What ORYH answered, as far as the pane cares: a list to show, or one record and its id. */
export function answerShape(text: string): { list: boolean; id?: string } {
  if (text.length > MAX_RESULT_BYTES) return { list: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { list: false }
  }
  const data = (parsed as { data?: unknown })?.data
  if (Array.isArray(data)) return { list: true }
  const id = (data as { id?: unknown })?.id
  return { list: false, ...(typeof id === 'string' && id ? { id } : {}) }
}
