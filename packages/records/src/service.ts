import { type ConnectionId, OryhClientError, userScope } from '@oryh/ai-client-foundation'
import { requirePage } from '@oryh/ai-client-pages'
import type {
  BusinessRecord,
  CollectionQuery,
  CollectionRecordQuery,
  OryhRecordRemote,
  ProductOption,
  ProductOptions,
  ProductSearch,
  RecordChild,
  RecordDetail,
  RecordDisplay,
  RecordFilterField,
  RecordFilters,
  RecordKind,
  RecordPage,
  RecordQuery,
  RecordRowField,
  RoleView,
} from './contracts.js'
import { inventoryProductQuery } from './inventory-product-query.js'
import { type CatalogueEntry, roleMenu } from './role-menu.js'
import { recordSpecs as specs } from './views.js'
import { fieldLabel, sectionLabel } from './words.js'

/**
 * The transport this service needs: one versioned GET inside an existing connection scope.
 * Declared structurally rather than imported, so this package does not depend on the core.
 */
export interface RecordHttp {
  request(connectionId: ConnectionId, request: { readonly path: `/${string}` }): Promise<unknown>
}

/** The connection facts this service reads; `ConnectionSummary` satisfies this shape. */
export interface RecordConnection {
  readonly origin: string
  readonly identity: {
    readonly permissions?: readonly string[]
    readonly user: { readonly id: string; readonly employeeId: string | null }
    readonly tenant: { readonly id: string }
  }
}

/**
 * What a Host offers this service to read with; the connection layer's `OryhDomainReads` satisfies it.
 * Written here as a shape, so this library names no Host.
 */
export interface RecordReads {
  readonly http: RecordHttp
  verify(id: string): Promise<RecordConnection>
  current(id: string): RecordConnection
  /** A lookup of what ORYH's own schema declares for each list. */
  lists(): {
    of(id: string, path: `/${string}`): Promise<readonly RecordFilterField[]>
    fieldsOf(id: string, path: `/${string}`): Promise<readonly RecordRowField[]>
  }
}

const fail = () => new OryhClientError('业务查询参数或返回数据无效。', 'request-failed')
export function decodeRecordPage(spec: RecordDisplay, body: unknown, page: number): RecordPage {
  if (!spec || !body || typeof body !== 'object') throw fail()
  const envelope = body as { data?: unknown; meta?: { total?: unknown; pages?: unknown } }
  if (
    !Array.isArray(envelope.data) ||
    !Number.isSafeInteger(envelope.meta?.total) ||
    !Number.isSafeInteger(envelope.meta?.pages)
  )
    throw fail()
  const rows = envelope.data.map((value: unknown): BusinessRecord => {
    if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') throw fail()
    const r = value as Record<string, unknown>,
      str = (k: string) =>
        r[k] == null ? '' : typeof r[k] === 'string' || typeof r[k] === 'number' ? String(r[k]) : ''
    return {
      id: str('id'),
      title: (spec.title ? str(spec.title) : '') || str('id'),
      status: str('status') || str('item_status'),
      summary: spec.summary ? str(spec.summary) : '',
      date: spec.date ? str(spec.date) : '',
      fields: [
        { field: 'id', label: '编号', value: str('id') },
        ...spec.columns.map(({ field, label }) => ({ field, label, value: str(field) || '—' })),
      ],
    }
  })
  return {
    rows,
    page,
    pages: Math.max(1, envelope.meta!.pages as number),
    total: envelope.meta!.total as number,
    fetchedAt: new Date().toISOString(),
  }
}
/** The display description as given, refused rather than repaired when it is not one. */
function display(given: RecordDisplay): RecordDisplay {
  if (!given || typeof given !== 'object' || !Array.isArray(given.columns)) throw fail()
  if (
    given.columns.length > 60 ||
    given.columns.some(
      c => !c || !/^[a-z_][a-z0-9_]{0,63}$/.test(c.field) || typeof c.label !== 'string' || !c.label,
    ) ||
    new Set(given.columns.map(c => c.field)).size !== given.columns.length
  )
    throw fail()
  return given
}

/**
 * Columns a role menu entry shows by default; the person can hide some. Twelve, because at ten an
 * invoice lost its total and its tax to the period and due dates declared before them.
 */
const ROLE_COLUMNS = 12
/** Fields a person does not read in a list: ids, the ids a row references, the tenant, the machinery. */
const LIST_PLUMBING = /^(id|tenant_id|custom_fields|metadata|idempotency_key|created_by|updated_by)$|_id$/

/** Columns a child table may show; past this it scrolls sideways and stops being read. */
const CHILD_COLUMNS = 16
/** Fields that name the tenant or the row's machinery, never something a person reads in a table. */
const PLUMBING = new Set(['tenant_id', 'deleted_at', 'custom_fields'])

/**
 * The arrays of records in a detail answer, each as a table of its scalar fields.
 * @param parent - the document opened, whose id a child row repeats in its foreign key.
 */
function children(body: unknown, parent: string): RecordChild[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const tables: RecordChild[] = []
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(value) || !value.length) continue
    const records = value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
    if (records.length !== value.length) continue
    const fields: string[] = []
    for (const record of records)
      for (const [field, cell] of Object.entries(record))
        if (!PLUMBING.has(field) && !fields.includes(field) && (cell === null || typeof cell !== 'object'))
          fields.push(field)
    // A row's own id, and a column that names the opened document on every row — `order_id` under that
    // very order — say nothing a person looking at the document does not already know.
    const repeatsParent = (field: string) => records.every(record => record[field] === parent)
    const shown = fields.filter(field => field !== 'id' && !repeatsParent(field)).slice(0, CHILD_COLUMNS)
    tables.push({
      key,
      // The shared words, as the todo page and the agent have them: a part by its name, a column by its field's.
      label: sectionLabel(key),
      columns: shown.map(field => ({ field, label: fieldLabel(field) })),
      rows: records.map(record =>
        Object.fromEntries(shown.map(field => [field, record[field] == null ? '' : String(record[field])])),
      ),
    })
  }
  return tables
}

/** One of the four built-in lists as a display description, so both go through the same decoder. */
export function builtInDisplay(kind: RecordKind): RecordDisplay {
  const spec = specs[kind]
  return {
    title: spec.title,
    summary: spec.summary,
    date: spec.date,
    columns: Object.entries(spec.fields).map(([field, label]) => ({ field, label })),
  }
}

/** How long a product's name is trusted before it is read again: names change rarely, pages turn often. */
const PRODUCT_NAME_TTL_MS = 10 * 60_000

export class RecordService implements OryhRecordRemote {
  readonly #productNames = new Map<string, { name: string; at: number }>()
  /**
   * @param http - versioned GET transport inside an existing connection scope.
   * @param verify - re-verifies the connection and returns its live identity.
   * @param current - the connection as last verified, for scope checks around a read.
   * @param declared - the query parameters a list endpoint declares on this deployment. Without it
   *   no filter can be validated, so filters are refused rather than sent unchecked.
   */
  constructor(
    private http: RecordHttp,
    private verify: (id: string) => Promise<RecordConnection>,
    private current: (id: string) => RecordConnection,
    private declared?: (id: string, path: `/${string}`) => Promise<readonly RecordFilterField[]>,
    private described?: (id: string, path: `/${string}`) => Promise<readonly RecordRowField[]>,
  ) {}
  /**
   * The service over what a Host offers a domain to read with: the Host does not know this service, so
   * the plugin that provides it builds it here.
   * @param reads - ORYH's reads as a connection, and how to ask who that connection is.
   * @returns a service of its own, with its own lookup of what the lists declare.
   */
  static over(reads: RecordReads): RecordService {
    const lists = reads.lists()
    return new RecordService(
      reads.http,
      id => reads.verify(id),
      id => reads.current(id),
      (id, path) => lists.of(id, path),
      (id, path) => lists.fieldsOf(id, path),
    )
  }
  /**
   * What a list can be filtered by, on this deployment, for this person.
   * @param connectionId - verified connection.
   * @param kind - list to describe.
   * @returns declared filterable parameters; paging and sort are excluded.
   */
  async recordFilterFields(connectionId: string, kind: RecordKind): Promise<RecordFilterField[]> {
    if (!Object.hasOwn(specs, kind)) throw fail()
    const c = await this.verify(connectionId)
    requirePage(c.identity, kind)
    if (!this.declared) throw new OryhClientError('当前部署无法读取列表的筛选字段。', 'invalid-response')
    return [...(await this.declared(connectionId, `/${kind}`))]
  }
  /**
   * Refuse a filter the endpoint does not declare, or a value its declared type cannot hold.
   *
   * The server ignores undeclared parameters without an error, so an unchecked typo would return
   * the whole list under a label that says it is filtered. That is the failure this exists to stop.
   * @returns the filters as query parameters, in a stable order.
   */
  private async checkedFilters(q: RecordQuery, filters: RecordFilters): Promise<[string, string][]> {
    // A product query walks inventory items and reads each one's movements by `inventory_item_id`, so that
    // key is the query's own. Every other declared filter rides along on those reads, still server-side.
    if (
      (q.productCode?.trim() || q.productIds?.length) &&
      filters !== null &&
      typeof filters === 'object' &&
      Object.hasOwn(filters, 'inventory_item_id')
    )
      throw new OryhClientError('产品查询已按库存项取数，不能再指定库存项编号作为查询条件。', 'request-failed')
    return this.checkedAgainst(q.connectionId, `/${q.kind}`, filters, q.query.trim() ? specs[q.kind].query : undefined)
  }

  /**
   * Check filter keys and values against what one list path declares on this deployment.
   * @param connectionId - verified connection.
   * @param path - list path, e.g. `/sales-order-items`.
   * @param filters - the filters as given.
   * @param usedBySearch - a declared parameter the search box is already using, if any.
   * @returns the filters as query parameters, in a stable order.
   */
  private async checkedAgainst(
    connectionId: string,
    path: `/${string}`,
    filters: RecordFilters,
    usedBySearch?: string,
  ): Promise<[string, string][]> {
    if (filters === null || typeof filters !== 'object' || Array.isArray(filters))
      throw new OryhClientError('筛选条件无效。', 'request-failed')
    const entries = Object.entries(filters)
    if (
      entries.length > 10 ||
      entries.some(
        ([k, v]) =>
          typeof k !== 'string' ||
          !/^[a-z_][a-z0-9_]{0,63}$/.test(k) ||
          typeof v !== 'string' ||
          !v.length ||
          v.length > 200,
      )
    )
      throw new OryhClientError('筛选条件无效：最多 10 个，键为字段名，值不能为空。', 'request-failed')
    if (!this.declared)
      throw new OryhClientError('当前部署无法读取列表的筛选字段，不能按条件筛选。', 'invalid-response')
    const fields = new Map((await this.declared(connectionId, path)).map(f => [f.name, f.type]))
    const textField = usedBySearch
    for (const [key, value] of entries) {
      const type = fields.get(key)
      if (type === undefined)
        throw new OryhClientError(
          `列表不支持按“${key}”筛选。可用字段：${[...fields.keys()].join('、') || '无'}。`,
          'request-failed',
        )
      if (key === textField)
        throw new OryhClientError(`“${key}”已由搜索框使用，不能同时作为筛选条件。`, 'request-failed')
      if (type === 'boolean' && value !== 'true' && value !== 'false')
        throw new OryhClientError(`“${key}”只能是 true 或 false。`, 'request-failed')
      if (type === 'integer' && !/^-?\d+$/.test(value))
        throw new OryhClientError(`“${key}”必须是整数。`, 'request-failed')
      if (type === 'number' && !Number.isFinite(Number(value)))
        throw new OryhClientError(`“${key}”必须是数字。`, 'request-failed')
    }
    return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }
  /** A collection as ORYH's own catalogue names it, which is also the last segment of its list path. */
  private static readonly COLLECTION = /^[a-z][a-z0-9-]{0,63}$/

  /**
   * What a collection can be filtered by on this deployment.
   * @param connectionId - verified connection.
   * @param collection - collection as ORYH names it.
   * @returns declared filterable parameters; paging and sort are excluded.
   */
  async collectionFilterFields(connectionId: string, collection: string): Promise<RecordFilterField[]> {
    const c = await this.verify(connectionId)
    this.admit(c, collection)
    if (!this.declared) throw new OryhClientError('当前部署无法读取列表的筛选字段。', 'invalid-response')
    return [...(await this.declared(connectionId, `/${collection}`))]
  }

  /**
   * What the rows of a collection carry, for choosing the columns of a menu entry.
   *
   * Empty is a real answer: a route that declares no response model has nothing here to read, and the
   * columns then have to come from someone who has seen the rows.
   * @param connectionId - verified connection.
   * @param collection - collection as ORYH names it.
   * @returns the row's scalar fields in the order the object declares them.
   */
  async collectionRowFields(connectionId: string, collection: string): Promise<RecordRowField[]> {
    const c = await this.verify(connectionId)
    this.admit(c, collection)
    if (!this.described) throw new OryhClientError('当前部署无法读取列表的字段。', 'invalid-response')
    return [...(await this.described(connectionId, `/${collection}`))]
  }

  /**
   * The menu this identity's permissions imply, each entry with the columns it shows by default.
   *
   * What collections exist is ORYH's catalogue; what this person works is their permissions
   * (`role-menu.ts`). The columns are the collection's own fields, less the ones a person does not read
   * in a list — its id, the ids it references, the tenant and the machinery — under the names in the
   * shared field dictionary, and a field it does not know under its own name.
   * @param connectionId - verified connection.
   * @returns entries this identity may open; empty when the catalogue cannot be read.
   */
  async roleViews(connectionId: string): Promise<RoleView[]> {
    const c = await this.verify(connectionId)
    const body = (await this.http.request(connectionId as ConnectionId, { path: '/builtin-object-types' })) as {
      data?: unknown
    }
    const catalogue = (Array.isArray(body?.data) ? body.data : []).filter(
      (e): e is CatalogueEntry =>
        !!e && typeof (e as CatalogueEntry).object_type === 'string' && typeof (e as CatalogueEntry).path === 'string',
    )
    const declared = (collection: string) =>
      this.declared ? this.declared(connectionId, `/${collection}`) : Promise.resolve([])
    const entries = await roleMenu(c.identity.permissions ?? [], catalogue, declared)
    const views: RoleView[] = []
    for (const entry of entries) {
      const fields = this.described ? await this.described(connectionId, `/${entry.collection}`).catch(() => []) : []
      const shown = fields.filter(f => !LIST_PLUMBING.test(f.name)).slice(0, ROLE_COLUMNS)
      if (!shown.length) continue
      const title = shown.find(f => /(_no|^name|^title)$/.test(f.name))?.name
      views.push({
        ...entry,
        display: {
          columns: shown.map(f => ({ field: f.name, label: fieldLabel(f.name) })),
          ...(title ? { title } : {}),
        },
      })
    }
    return views
  }

  /**
   * A document's child tables — an order's lines, its approvals, its attachments — from ORYH's own
   * `/{collection}/{id}/detail`.
   *
   * A list row carries only the document's own fields, so an order opened from the list showed nothing
   * of what it contained. The detail is ORYH's, and so is the set of tables in it: every array of
   * records it returns is shown, whatever the collection. A collection with no detail route answers
   * 404, which means "no child tables", not a failure.
   * @param connectionId - verified connection.
   * @param collection - collection as ORYH names it.
   * @param id - the document.
   * @returns the child tables, in the order the detail lists them.
   */
  async recordDetail(connectionId: string, collection: string, id: string): Promise<RecordDetail> {
    if (typeof id !== 'string' || !id || id.length > 200 || /[/?#\\]/.test(id)) throw fail()
    const c = await this.verify(connectionId),
      scope = userScope
    this.admit(c, collection)
    let body: unknown
    try {
      body = await this.http.request(connectionId as ConnectionId, {
        path: `/${collection}/${encodeURIComponent(id)}/detail`,
      })
    } catch (error) {
      if (error instanceof OryhClientError && (error.status === 404 || error.status === 405)) return { children: [] }
      throw error
    }
    if (scope(c) !== scope(this.current(connectionId)))
      throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
    return { children: children(body, id) }
  }

  /**
   * One page of a collection a menu entry names.
   *
   * What exists is ORYH's answer, not a list kept here: an unknown collection comes back from the
   * deployment as a 404, which is the truth about that deployment rather than a guess made locally.
   * @param q - the collection, the page, the filters and how to show it.
   * @returns the page, decoded as the entry's display says.
   */
  async collectionList(q: CollectionQuery): Promise<RecordPage> {
    if (!Number.isSafeInteger(q.page) || q.page < 1) throw fail()
    const c = await this.verify(q.connectionId),
      scope = userScope
    const collection = this.admit(c, q.collection)
    const filters = await this.checkedAgainst(q.connectionId, `/${collection}`, q.filters ?? {})
    const params = new URLSearchParams({ page: String(q.page), size: '25' })
    for (const [key, value] of filters) params.set(key, value)
    const body = await this.http.request(q.connectionId as ConnectionId, { path: `/${collection}?${params}` })
    if (scope(c) !== scope(this.current(q.connectionId)))
      throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
    return decodeRecordPage(display(q.display), body, q.page)
  }

  /**
   * One record of a collection a menu entry names, by id.
   *
   * The entry's list is a page of what its filters leave; the record someone means — named in a Chat
   * answer, or just written by the agent — is seldom on it. Read through the collection's own route and
   * decoded as a row of the entry, it can be shown wherever it would sort, or when the entry's filters
   * would leave it out.
   * @returns the record, as a row of that entry.
   */
  async collectionGet(q: CollectionRecordQuery): Promise<BusinessRecord> {
    if (typeof q.id !== 'string' || !q.id || q.id.length > 200 || /[/?#\\\s]/.test(q.id)) throw fail()
    const c = await this.verify(q.connectionId),
      scope = userScope
    const collection = this.admit(c, q.collection)
    const body = (await this.http.request(q.connectionId as ConnectionId, {
      path: `/${collection}/${encodeURIComponent(q.id)}`,
    })) as { data?: unknown }
    if (scope(c) !== scope(this.current(q.connectionId)))
      throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
    const { rows } = decodeRecordPage(display(q.display), { data: [body?.data], meta: { total: 1, pages: 1 } }, 1)
    const record = rows[0]
    if (record?.id !== q.id) throw fail()
    return record
  }

  /**
   * Refuse a collection this client will not address, or one whose built-in page bars this identity.
   * @returns the collection, once it is one this deployment could have.
   */
  private admit(c: RecordConnection, collection: string): string {
    if (typeof collection !== 'string' || !RecordService.COLLECTION.test(collection)) throw fail()
    return collection
  }

  async productSearch(q: ProductSearch): Promise<ProductOptions> {
    if (
      typeof q.query !== 'string' ||
      q.query.length > 200 ||
      !Number.isSafeInteger(q.page) ||
      q.page < 1 ||
      (q.ids !== undefined &&
        (!Array.isArray(q.ids) ||
          q.ids.length > 50 ||
          q.ids.some(id => typeof id !== 'string' || !id || id.length > 200) ||
          new Set(q.ids).size !== q.ids.length))
    )
      throw fail()
    const c = await this.verify(q.connectionId),
      scope = userScope
    const read = async (path: `/${string}`) => {
      if (scope(c) !== scope(this.current(q.connectionId))) throw fail()
      const body = await this.http.request(q.connectionId as ConnectionId, { path })
      if (scope(c) !== scope(this.current(q.connectionId))) throw fail()
      return body
    }
    requirePage(c.identity, 'inventory-item-details')
    const decode = (value: unknown): ProductOption => {
      const p = value as Record<string, unknown>
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') throw fail()
      return { id: p.id, name: p.name, code: typeof p.product_code === 'string' ? p.product_code : '' }
    }
    if (q.ids) {
      const rows: ProductOption[] = []
      for (const id of q.ids) {
        const body = (await read(`/products/${encodeURIComponent(id)}`)) as { data: unknown }
        const option = decode(body.data)
        if (option.id !== id) throw fail()
        rows.push(option)
      }
      return { rows, total: rows.length, pages: 1 }
    }
    const params = new URLSearchParams({ keyword: q.query.trim(), page: String(q.page), size: '20' })
    const body = (await read(`/products?${params}`)) as { data: unknown[]; meta: { total: number; pages: number } }
    if (
      !Array.isArray(body?.data) ||
      !Number.isSafeInteger(body.meta?.total) ||
      !Number.isSafeInteger(body.meta?.pages)
    )
      throw fail()
    return { rows: body.data.map(decode), total: body.meta.total, pages: Math.max(1, body.meta.pages) }
  }
  async recordList(q: RecordQuery) {
    if (
      !Object.hasOwn(specs, q.kind) ||
      !Number.isSafeInteger(q.page) ||
      q.page < 1 ||
      typeof q.query !== 'string' ||
      q.query.length > 200
    )
      throw fail()
    if (
      q.productIds !== undefined &&
      (q.kind !== 'inventory-item-details' ||
        !Array.isArray(q.productIds) ||
        q.productIds.length > 50 ||
        q.productIds.some(id => typeof id !== 'string' || !id || id.length > 200) ||
        new Set(q.productIds).size !== q.productIds.length ||
        !!q.productCode?.trim())
    )
      throw fail()
    if (
      q.productCode !== undefined &&
      (q.kind !== 'inventory-item-details' || typeof q.productCode !== 'string' || q.productCode.length > 200)
    )
      throw fail()
    const c = await this.verify(q.connectionId),
      scope = userScope
    requirePage(c.identity, q.kind)
    const filters = q.filters === undefined ? [] : await this.checkedFilters(q, q.filters)
    const params = new URLSearchParams({ page: String(q.page), size: '25' })
    if (q.query.trim()) params.set(specs[q.kind].query, q.query.trim())
    for (const [key, value] of filters) params.set(key, value)
    const read = async (path: `/${string}`) => {
      if (scope(c) !== scope(this.current(q.connectionId)))
        throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
      return this.http.request(q.connectionId as ConnectionId, { path })
    }
    const body =
      q.productCode?.trim() || q.productIds?.length
        ? await inventoryProductQuery(q, read, filters)
        : await read(`/${q.kind}?${params}`)
    if (scope(c) !== scope(this.current(q.connectionId)))
      throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
    const result = decodeRecordPage(builtInDisplay(q.kind), body, q.page)
    await this.withPositions(
      q.connectionId,
      q.kind,
      result.rows,
      () => scope(c) === scope(this.current(q.connectionId)),
    )
    return result
  }

  /**
   * One record of a built-in list by id, as that list would show it in a row.
   *
   * A list shows a page of what its filters leave; a record the agent names — the order it just wrote,
   * the one a todo points at — is usually not on it. Opening that record used to mean opening the list
   * and hoping (R2-21: a new draft order hidden behind a saved status filter). This reads the one record
   * through the list's own route and decodes it as a row, so the page can show it wherever it sorts.
   * @param connectionId - verified connection.
   * @param kind - the list the record belongs to.
   * @param id - the record.
   * @returns the record, as a row of that list.
   */
  async recordGet(connectionId: string, kind: RecordKind, id: string): Promise<BusinessRecord> {
    if (!Object.hasOwn(specs, kind) || typeof id !== 'string' || !id || id.length > 200 || /[/?#\\]/.test(id))
      throw fail()
    const c = await this.verify(connectionId),
      scope = userScope
    requirePage(c.identity, kind)
    const body = (await this.http.request(connectionId as ConnectionId, {
      path: `/${kind}/${encodeURIComponent(id)}`,
    })) as { data?: unknown }
    const same = () => scope(c) === scope(this.current(connectionId))
    if (!same()) throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
    const { rows } = decodeRecordPage(builtInDisplay(kind), { data: [body?.data], meta: { total: 1, pages: 1 } }, 1)
    const record = rows[0]
    if (record?.id !== id) throw fail()
    await this.withPositions(connectionId, kind, rows, same)
    return record
  }

  /**
   * Fill in what an inventory movement's row cannot say for itself: the product and warehouse of the
   * position it moved. Other lists are left as they are.
   * @param same - whether the connection is still the identity the read began under.
   */
  private async withPositions(
    connectionId: string,
    kind: RecordKind,
    rows: BusinessRecord[],
    same: () => boolean,
  ): Promise<void> {
    if (kind === 'inventory-item-details') {
      const result = { rows }
      // Resolve only inventory positions present on this page, through the same tenant connection.
      const ids = [
        ...new Set(
          result.rows
            .map(row => row.fields.find(f => f.label === '库存项编号')?.value)
            .filter((id): id is string => !!id && id !== '—'),
        ),
      ]
      const positions = new Map<string, Record<string, unknown>>()
      for (let offset = 0; offset < ids.length; offset += 5)
        await Promise.all(
          ids.slice(offset, offset + 5).map(async id => {
            try {
              const response = (await this.http.request(connectionId as ConnectionId, {
                path: `/inventory-items/${encodeURIComponent(id)}`,
              })) as { data?: Record<string, unknown> }
              if (response.data?.id === id) positions.set(id, response.data)
            } catch {
              /* Missing or inaccessible relations remain explicitly unavailable. */
            }
          }),
        )
      // A position names its product by id and code; the name is on the product, one read further.
      const names = await this.productNames(connectionId, [
        ...new Set(
          [...positions.values()]
            .map(position => position.product_id)
            .filter((id): id is string => typeof id === 'string' && id !== ''),
        ),
      ])
      if (!same()) throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
      for (const row of result.rows) {
        const position = positions.get(row.fields.find(f => f.label === '库存项编号')?.value ?? '')
        for (const [key, label] of [
          ['product_code', '产品编码'],
          ['facility', '仓库'],
        ] as const) {
          const field = row.fields.find(f => f.label === label)
          if (field) field.value = typeof position?.[key] === 'string' ? (position[key] as string) : '—'
        }
        const name = row.fields.find(f => f.label === '产品名称')
        if (name) name.value = names.get(String(position?.product_id ?? '')) ?? '—'
      }
    }
  }

  /**
   * Product names by id, read five at a time and kept for ten minutes per enterprise. ORYH lists products
   * by keyword, not by ids, so each is one read; a product that cannot be read has no name, not an error.
   */
  private async productNames(connectionId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    const now = Date.now()
    const missing = ids.filter(id => {
      const cached = this.#productNames.get(`${connectionId}:${id}`)
      if (cached && now - cached.at < PRODUCT_NAME_TTL_MS) names.set(id, cached.name)
      return !names.has(id)
    })
    for (let offset = 0; offset < missing.length; offset += 5)
      await Promise.all(
        missing.slice(offset, offset + 5).map(async id => {
          try {
            const response = (await this.http.request(connectionId as ConnectionId, {
              path: `/products/${encodeURIComponent(id)}`,
            })) as { data?: Record<string, unknown> }
            const name = response.data?.id === id ? response.data.name : undefined
            if (typeof name !== 'string' || !name) return
            names.set(id, name)
            this.#productNames.set(`${connectionId}:${id}`, { name, at: now })
          } catch {
            /* A product this person may not read, or one that is gone, stays unnamed. */
          }
        }),
      )
    return names
  }
}
