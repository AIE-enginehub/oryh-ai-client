import type { ConnectionId } from './brand.js'
import { API_PREFIX, type OryhHttpClient } from './http.js'

/** One query parameter a list endpoint declares, which is what a saved filter may use. */
export interface ListParameter {
  readonly name: string
  readonly type: 'string' | 'integer' | 'number' | 'boolean'
}

/** One field the rows of a list carry, as the deployment's own schema describes it. */
export interface ListField {
  readonly name: string
  readonly type: 'string' | 'integer' | 'number' | 'boolean'
  /** The endpoint always sends it, so a column over it is never blank for want of the field. */
  readonly required: boolean
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

  /**
   * The fields the rows of one list endpoint carry.
   * @param id - verified connection whose deployment to ask.
   * @param path - list path as the client requests it, e.g. `/sales-order-items`.
   * @returns the row's scalar fields in declaration order; empty when the path is unknown.
   */
  async fieldsOf(id: string, path: `/${string}`): Promise<readonly ListField[]> {
    const hit = this.cache.get(id)
    const spec = hit !== undefined && Date.now() - hit.at < this.ttlMs ? hit.spec : await this.load(id)
    return fields(spec, `${API_PREFIX}${path}`)
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

/** Follow one `#/components/schemas/<name>` reference; anything else is not a schema we can read. */
function deref(spec: unknown, node: unknown): unknown {
  const ref = (node as { $ref?: unknown } | null)?.$ref
  if (typeof ref !== 'string') return node
  const name = ref.startsWith(COMPONENT_PREFIX) ? ref.slice(COMPONENT_PREFIX.length) : undefined
  if (name === undefined || name.includes('/')) return undefined
  const schemas = (spec as { components?: { schemas?: Record<string, unknown> } } | null)?.components?.schemas
  return schemas?.[name]
}

const COMPONENT_PREFIX = '#/components/schemas/'

/**
 * Pull the row fields of one list operation out of an OpenAPI document.
 *
 * The shape ORYH serves is a list envelope — `{ data: Item[], meta }` — named by a component whose
 * `data` items name another. Both are followed here rather than assumed, and a document that does not
 * have that shape yields nothing, which reads to the caller as "this path has no list to show".
 *
 * Only scalar fields are returned: a column shows one value, and an object or an array of them has no
 * single rendering this client could choose. The order is the schema's, which is the order the people
 * who defined the object wrote it in.
 * @param spec - parsed OpenAPI document.
 * @param key - path key as the document spells it, prefix included.
 * @returns the row's scalar fields in declaration order.
 */
export function fields(spec: unknown, key: string): readonly ListField[] {
  const paths = (spec as { paths?: Record<string, { get?: unknown }> } | null)?.paths
  const get = paths?.[key]?.get as { responses?: Record<string, unknown> } | undefined
  const ok = get?.responses?.['200'] as { content?: Record<string, { schema?: unknown }> } | undefined
  const envelope = deref(spec, ok?.content?.['application/json']?.schema) as
    | { properties?: { data?: { items?: unknown; type?: unknown } } }
    | undefined
  const data = envelope?.properties?.data
  if (data?.type !== 'array') return []
  const item = deref(spec, data.items) as { properties?: Record<string, unknown>; required?: unknown } | undefined
  if (!item?.properties || typeof item.properties !== 'object') return []
  const required = new Set(Array.isArray(item.required) ? item.required.filter(n => typeof n === 'string') : [])
  return Object.entries(item.properties).flatMap(([name, schema]) => {
    const type = scalar(schema)
    return type === undefined ? [] : [{ name, type, required: required.has(name) }]
  })
}
