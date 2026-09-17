import type { ConnectionId } from './brand.js'
import { API_PREFIX, type OryhHttpClient } from './http.js'

/** One query parameter a list endpoint declares, which is what a saved filter may use. */
export interface ListParameter {
  readonly name: string
  readonly type: 'string' | 'integer' | 'number' | 'boolean'
}

/**
 * Parameters a view manages itself, so a saved filter must not set them: paging and sort belong to
 * the list on screen, not to the definition of what the list is.
 */
const MANAGED = new Set(['page', 'size', 'order_by'])

/**
 * What each ORYH list endpoint accepts as a filter, read from the deployment's own OpenAPI.
 *
 * The point is not documentation. FastAPI silently ignores a query parameter it does not declare,
 * so a saved filter with a misspelt key — `directon=inbound` — returns EVERY row, under a menu
 * entry that says it is filtered. Checking keys against what the endpoint declares is the only
 * thing standing between a typo and a list that quietly lies. And the answer is the deployment's,
 * never a table in this client: each ORYH version adds parameters on its own schedule.
 */
export class ListParameters {
  private cache = new Map<string, { at: number; spec: unknown }>()
  /**
   * @param http - transport that can fetch the deployment's schema.
   * @param ttlMs - how long one schema serves; it only changes when ORYH is redeployed.
   */
  constructor(
    private readonly http: Pick<OryhHttpClient, 'schema'>,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  /**
   * The filterable query parameters of one list endpoint.
   * @param id - verified connection whose deployment to ask.
   * @param path - list path as the client requests it, e.g. `/shipments`.
   * @returns declared query parameters minus paging and sort; empty when the path is unknown.
   */
  async of(id: string, path: `/${string}`): Promise<readonly ListParameter[]> {
    const hit = this.cache.get(id)
    const spec = hit !== undefined && Date.now() - hit.at < this.ttlMs ? hit.spec : await this.load(id)
    return parameters(spec, `${API_PREFIX}${path}`)
  }

  private async load(id: string): Promise<unknown> {
    const spec = await this.http.schema(id as ConnectionId)
    this.cache.set(id, { at: Date.now(), spec })
    return spec
  }
}

/**
 * Pull the query parameters of one GET operation out of an OpenAPI document.
 * @param spec - parsed OpenAPI document.
 * @param key - path key as the document spells it, prefix included.
 * @returns filterable parameters in declaration order.
 */
export function parameters(spec: unknown, key: string): readonly ListParameter[] {
  const paths = (spec as { paths?: Record<string, { get?: { parameters?: unknown } }> } | null)?.paths
  const declared = paths?.[key]?.get?.parameters
  if (!Array.isArray(declared)) return []
  return declared.flatMap(entry => {
    const p = entry as { in?: unknown; name?: unknown; schema?: unknown }
    if (p.in !== 'query' || typeof p.name !== 'string' || MANAGED.has(p.name)) return []
    const type = scalar(p.schema)
    return type === undefined ? [] : [{ name: p.name, type }]
  })
}

/** The scalar type of a parameter schema, seeing through FastAPI's `anyOf: [T, null]` for optionals. */
function scalar(schema: unknown): ListParameter['type'] | undefined {
  const s = schema as { type?: unknown; anyOf?: unknown } | null
  const candidates = Array.isArray(s?.anyOf) ? s.anyOf : [s]
  for (const candidate of candidates) {
    const type = (candidate as { type?: unknown } | null)?.type
    if (type === 'string' || type === 'integer' || type === 'number' || type === 'boolean') return type
  }
  return undefined
}
