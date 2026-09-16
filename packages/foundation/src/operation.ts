/**
 * What a write on the multi-user server carries so the control process can admit and record it
 * (docs/34 §4.1). Attached by trusted Host code, never by the model; the desktop client ignores it.
 */
export type OryhOperation =
  | {
    /** A write the person confirmed on a page. */
    readonly kind: 'page'
    /** One per write. */
    readonly operationId: string
    /** SHA-256 hex of `operationDigestInput` for the request the person confirmed. */
    readonly digest: string
    /** When the person confirmed, in epoch milliseconds. */
    readonly confirmedAt: number
  }
  | {
    /** A write an agent made from a chat session, confirmed or not as its skill requires. */
    readonly kind: 'chat'
    /** One per tool call. */
    readonly operationId: string
    readonly sessionId: string
    readonly callId: string
  }

/** JSON with object keys in a fixed order, so equal values hash equally wherever they were built. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/**
 * The text a write's digest is taken over: method, path as sent, and canonical body. Hashing is left
 * to the caller, because this package also runs in the browser, where Node's crypto is not.
 */
export function operationDigestInput(request: { readonly method?: string; readonly path: string; readonly body?: unknown }): string {
  return canonicalJson([request.method ?? 'GET', request.path, request.body ?? null])
}

/**
 * The description a page attaches to a write the person has just confirmed.
 * @param operationId - unique for this write.
 * @param request - exactly what will be sent.
 * @param sha256 - hex SHA-256 of a string (Node: `createHash('sha256').update(text).digest('hex')`).
 * @returns the page operation, confirmed now.
 */
export function pageOperation(operationId: string, request: { readonly method?: string; readonly path: string; readonly body?: unknown }, sha256: (text: string) => string): OryhOperation {
  return { kind: 'page', operationId, digest: sha256(operationDigestInput(request)), confirmedAt: Date.now() }
}
