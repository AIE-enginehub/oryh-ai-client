import { type ConnectionId, OryhClientError, userScope } from '@oryh/ai-client-foundation'
import { requirePage } from '@oryh/ai-client-pages'
import type {
  BusinessRecord,
  OryhRecordRemote,
  ProductOption,
  ProductOptions,
  ProductSearch,
  RecordFilterField,
  RecordFilters,
  RecordKind,
  RecordPage,
  RecordQuery,
} from './contracts.js'
import { inventoryProductQuery } from './inventory-product-query.js'
import { recordSpecs as specs } from './views.js'

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

const fail = () => new OryhClientError('业务查询参数或返回数据无效。', 'request-failed')
export function decodeRecordPage(kind: RecordKind, body: unknown, page: number): RecordPage {
  const spec = specs[kind]
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
      title: str(spec.title) || str('id'),
      status: str('status') || str('item_status'),
      summary: str(spec.summary),
      date: str(spec.date),
      fields: [
        { label: '编号', value: str('id') },
        ...Object.entries(spec.fields).map(([key, label]) => ({ label, value: str(key) || '—' })),
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
export class RecordService implements OryhRecordRemote {
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
  ) {}
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
    // A product query walks inventory items and reads each one's movements by `inventory_item_id`, so that
    // key is the query's own. Every other declared filter rides along on those reads, still server-side.
    if ((q.productCode?.trim() || q.productIds?.length) && Object.hasOwn(filters, 'inventory_item_id'))
      throw new OryhClientError('产品查询已按库存项取数，不能再指定库存项编号作为查询条件。', 'request-failed')
    if (!this.declared)
      throw new OryhClientError('当前部署无法读取列表的筛选字段，不能按条件筛选。', 'invalid-response')
    const fields = new Map((await this.declared(q.connectionId, `/${q.kind}`)).map(f => [f.name, f.type]))
    const textField = specs[q.kind].query
    for (const [key, value] of entries) {
      const type = fields.get(key)
      if (type === undefined)
        throw new OryhClientError(
          `列表不支持按“${key}”筛选。可用字段：${[...fields.keys()].join('、') || '无'}。`,
          'request-failed',
        )
      if (key === textField && q.query.trim())
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
    const result = decodeRecordPage(q.kind, body, q.page)
    if (q.kind === 'inventory-item-details') {
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
              const response = (await this.http.request(q.connectionId as ConnectionId, {
                path: `/inventory-items/${encodeURIComponent(id)}`,
              })) as { data?: Record<string, unknown> }
              if (response.data?.id === id) positions.set(id, response.data)
            } catch {
              /* Missing or inaccessible relations remain explicitly unavailable. */
            }
          }),
        )
      if (scope(c) !== scope(this.current(q.connectionId)))
        throw new OryhClientError('企业连接已变化，请重新查询。', 'cross-connection-result')
      for (const row of result.rows) {
        const position = positions.get(row.fields.find(f => f.label === '库存项编号')?.value ?? '')
        for (const [key, label] of [
          ['product_code', '产品编码'],
          ['facility', '仓库'],
        ] as const) {
          const field = row.fields.find(f => f.label === label)
          if (field) field.value = typeof position?.[key] === 'string' ? (position[key] as string) : '—'
        }
      }
    }
    return result
  }
}
