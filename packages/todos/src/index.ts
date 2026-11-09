import { type ConnectionId, connectionId, OryhClientError } from '@oryh/ai-client-foundation'

export interface TodoDocument {
  todoId: string
  title: string
  entityType: string
  entityId: string
  fetchedAt: string
  sections: { name: string; fields: { name: string; value: string }[] }[]
}

/** The transport this service needs: one versioned GET inside an existing connection scope. */
export interface TodoHttp {
  request(connectionId: ConnectionId, request: { readonly path: `/${string}` }): Promise<unknown>
}

/** The connection facts this service reads; `ConnectionSummary` satisfies this shape. */
export interface TodoConnection {
  readonly identity: { readonly user: { readonly employeeId: string | null } }
}

/**
 * What a Host offers this service to read with; the connection layer's `OryhDomainReads` satisfies it.
 * Written here as a shape, so this library names no Host.
 */
export interface TodoReads {
  readonly http: TodoHttp
  /** A connection already verified. */
  current(id: string): TodoConnection
  /** The same, once a verification under way has settled. */
  settled(id: string): Promise<TodoConnection>
}

/**
 * Narrow a response fragment to an object.
 *
 * This used to be imported from the expense contracts, so a malformed todo response
 * reported an expense conflict. The code is now `invalid-response`, which this service
 * already raises for a mismatched linked document. No test or consumer observed the old
 * code, so this is a deliberate correction rather than a silent change.
 * @param value - decoded response fragment.
 * @returns the value as a record.
 */
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new OryhClientError('待办数据无效。', 'invalid-response')
  return value as Record<string, unknown>
}

/**
 * What never enters Chat from a linked document, by category rather than by name: custom fields, whose
 * contents nobody here chose; attachments; system metadata; the tenant; and anything that names a
 * credential. Everything else a document carries is its business content, whatever the document is.
 */
const WITHHELD = new Set(['custom_fields', 'attachments', 'metadata', 'tenant_id'])
const CREDENTIAL = /token|secret|password|passwd|credential|api_?key|private_?key/i
const withheld = (key: string) => WITHHELD.has(key) || key.endsWith('_jsonb') || CREDENTIAL.test(key)

/** How deep the projection follows nested records: a document, its lines, and what a line names. */
const DEPTH = 4

function project(value: unknown, path: string, output: TodoDocument['sections'], depth = 0): void {
  if (depth > DEPTH) return
  if (Array.isArray(value)) {
    value.forEach((v, i) => project(v, `${path} ${i + 1}`, output, depth + 1))
    return
  }
  if (!value || typeof value !== 'object') return
  const entries = Object.entries(value).filter(([key]) => !withheld(key)),
    flat = entries
      .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
      .map(([name, v]) => ({ name, value: v === null ? '—' : String(v) }))
  if (flat.length) output.push({ name: path, fields: flat })
  // Every nested record is followed — a sales order's lines, a leave's approvals, a custom object's
  // children — so a document type this client has never seen still shows what hangs off it.
  for (const [key, v] of entries)
    if (v !== null && typeof v === 'object' && (!Array.isArray(v) || v.some(x => x && typeof x === 'object')))
      project(v, `${path}/${key}`, output, depth + 1)
}

/** One entry of ORYH's own catalogue: a collection, its list path, and the words that mean it. */
interface CatalogueEntry {
  object_type: string
  path: string
  also_called?: string[]
}

/** How long one catalogue serves: it changes only when ORYH ships a collection. */
const CATALOGUE_TTL_MS = 10 * 60_000

export class TodoDetailService {
  private catalogues = new Map<string, { at: number; entries: CatalogueEntry[] }>()
  constructor(
    private http: TodoHttp,
    private connection: (id: string) => TodoConnection,
    private verify: (id: string) => Promise<TodoConnection>,
  ) {}

  /**
   * The service over what a Host offers a domain to read with: the Host does not know this service, so
   * the plugin that provides it builds it here.
   * @param reads - ORYH's reads as a connection, and how to ask who that connection is.
   * @returns a service of its own.
   */
  static over(reads: TodoReads): TodoDetailService {
    return new TodoDetailService(
      reads.http,
      id => reads.current(id),
      id => reads.settled(id),
    )
  }

  /**
   * Where a todo's linked document lives, as ORYH's own catalogue says.
   *
   * A todo names its document by `entity_type` — `employee_leave`, `sales_order`, `business_object` for a
   * tenant's own object — and `GET /builtin-object-types` lists every collection with the words that
   * mean it, singular included. ORYH derives that list from its own routes, so a document type added
   * next month is readable here the day its endpoint is, with nothing to add to this client.
   * @param id - verified connection.
   * @param entityType - the todo's `entity_type`.
   * @returns the collection's path, e.g. `/employee-leaves`, or undefined when ORYH has no such collection.
   */
  private async pathOf(id: string, entityType: string): Promise<`/${string}` | undefined> {
    const hit = this.catalogues.get(id)
    let entries = hit !== undefined && Date.now() - hit.at < CATALOGUE_TTL_MS ? hit.entries : undefined
    if (!entries) {
      const body = object(await this.http.request(connectionId(id), { path: '/builtin-object-types' }))
      entries = (Array.isArray(body.data) ? body.data : []).filter(
        (e): e is CatalogueEntry => !!e && typeof e.object_type === 'string' && typeof e.path === 'string',
      )
      this.catalogues.set(id, { at: Date.now(), entries })
    }
    const entry = entries.find(e => e.object_type === entityType || (e.also_called ?? []).includes(entityType))
    return entry && /^\/[a-z][a-z0-9-]{0,63}$/.test(entry.path) ? (entry.path as `/${string}`) : undefined
  }

  /** The document ORYH answered: the one record in it whose id is the todo's entity id. */
  private static documentIn(data: Record<string, unknown>, entityId: string): Record<string, unknown> | undefined {
    if (data.id === entityId) return data
    for (const value of Object.values(data))
      if (value && typeof value === 'object' && !Array.isArray(value) && (value as { id?: unknown }).id === entityId)
        return value as Record<string, unknown>
    return undefined
  }
  async read(id: string, todoId: string): Promise<TodoDocument> {
    await this.verify(id)
    const c = this.connection(id),
      scope = JSON.stringify(c.identity),
      employee = c.identity.user.employeeId
    if (!employee) throw new OryhClientError('账号未关联员工。', 'employee-required')
    const guard = () => {
      if (JSON.stringify(this.connection(id).identity) !== scope)
        throw new OryhClientError('企业身份已改变。', 'connection-identity-mismatch')
    }
    const todo = object(
      object(await this.http.request(connectionId(id), { path: `/todos/${encodeURIComponent(todoId)}` })).data,
    )
    guard()
    if (todo.id !== todoId || todo.employee_id !== employee)
      throw new OryhClientError('只能读取分配给当前员工的待办。', 'cross-connection-result')
    const entityType = String(todo.entity_type),
      entityId = String(todo.entity_id)
    const path = await this.pathOf(id, entityType)
    guard()
    if (!path)
      throw new OryhClientError(`ORYH 的对象目录里没有“${entityType}”，无法读取关联单据。`, 'operation-not-found')
    // The detail, where the collection has one, carries the lines and approvals; otherwise the record.
    const record = `${path}/${encodeURIComponent(entityId)}` as const
    let answer: unknown
    try {
      answer = await this.http.request(connectionId(id), { path: `${record}/detail` })
    } catch (error) {
      if (!(error instanceof OryhClientError && (error.status === 404 || error.status === 405))) throw error
      answer = await this.http.request(connectionId(id), { path: record })
    }
    const detail = object(object(answer).data)
    guard()
    if (!TodoDetailService.documentIn(detail, entityId))
      throw new OryhClientError('关联单据与待办不匹配。', 'invalid-response')
    const sections: TodoDocument['sections'] = []
    project(todo, 'todo', sections)
    project(detail, entityType, sections)
    return { todoId, title: String(todo.title), entityType, entityId, fetchedAt: new Date().toISOString(), sections }
  }
}
