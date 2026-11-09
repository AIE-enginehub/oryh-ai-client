/**
 * Reading and arithmetic for one custom-page run: the tool calls a page's data subagent makes between its
 * first read and publishing a result. It is separate from the page service so the limits, paging and
 * permission re-checks can be tested on their own, without a page, a Chat or a model.
 */
import type { PageReader } from '@oryh/ai-client-core'
import { type ConnectionId } from '@oryh/ai-client-foundation'
import type { BusinessRecord, OryhRecordRemote, RecordDisplay } from '@oryh/ai-client-records'
import { type CalculationRequest, calculateRows, jsonDataset, recordsDataset } from './custom-calculation.js'
import { type CustomDefinition, type CustomJson, customFail, validateResult } from './custom-model.js'
import type { ActiveRun } from './custom-service.js'
import { decimal, decimalText } from './model.js'

/** Rows one dataset may have: a read that would have more fails and says to narrow it. */
export const MAX_ROWS = 1000
/** What one run may read (docs/48 §17): ORYH requests, pages included; rows over all datasets; datasets. */
export const RUN_REQUESTS = 200
export const RUN_ROWS = 20_000
export const RUN_DATASETS = 50
const FETCH_PAGE = 100
/** Rows a read hands the model at a time, and the most it may ask for; a page also stops at READ_CHARS. */
const READ_PAGE = 50
const READ_PAGE_MAX = 200
/**
 * Under what Harness keeps inline in a tool result: since DSH 0.1.7 that is 12,500 tokens, estimated at
 * four characters each, and past it the result is spilled to a file the page's run has no tool to read.
 */
const READ_CHARS = 45_000

export function displayOf(source: CustomDefinition['task']['sources'][number]): RecordDisplay {
  return {
    columns: source.display.columns,
    ...(source.display.title ? { title: source.display.title } : {}),
    ...(source.display.summary ? { summary: source.display.summary } : {}),
    ...(source.display.date ? { date: source.display.date } : {}),
  }
}

/** What the data engine needs from the service that owns the run. */
export interface CustomDataOptions {
  readonly reader?: Pick<PageReader, 'read'>
  readonly records: OryhRecordRemote
  readonly runOf: (agentId: string) => ActiveRun
  readonly scope: (request: ActiveRun['parent']) => Promise<{ key: string }>
  readonly step: (active: ActiveRun, step?: string) => void
  readonly runText: (active: ActiveRun, zh: string, en: string) => string
}

export class CustomDataRun {
  constructor(private readonly options: CustomDataOptions) {}

  /**
   * One page of a dataset's rows, by field name. A declared source is read in full the first time it is
   * named, which the run's figures and provenance rest on; later calls page through that same read. The
   * model gets a page at a time, because a whole dataset would not fit in what it can hold — totals come
   * from calculate.
   */
  async read(agentId: string, name: string, offset = 0, limit = READ_PAGE): Promise<string> {
    const active = this.options.runOf(agentId)
    if (!Number.isSafeInteger(offset) || offset < 0) customFail('offset 须是非负整数。')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_PAGE_MAX)
      customFail(`limit 须在 1 到 ${READ_PAGE_MAX} 之间。`)
    if (!active.datasets.has(name)) {
      const source = active.definition.task.sources.find(s => s.collection === name)
      if (!source) customFail(`没有名为 ${name} 的数据集：先用 oryh_custom_page_fetch 读取，或读任务列出的来源。`)
      this.options.step(active, this.options.runText(active, `正在读取 ${name}…`, `Reading ${name}…`))
      await this.loadOnce(active, name, () => this.readSource(active, source))
      this.options.step(
        active,
        this.options.runText(
          active,
          `已读取 ${name}，共 ${active.datasets.get(name)?.dataset.rows.length ?? 0} 条；AI 正在处理…`,
          `Read ${name}: ${active.datasets.get(name)?.dataset.rows.length ?? 0} records. Processing…`,
        ),
      )
    }
    return this.page(active, name, offset, limit)
  }

  /**
   * Read one ORYH path as the page's owner and keep what it answered as a named dataset (docs/48 §17). A
   * list is read in full, page by page; `rows` takes a list out of a single record, such as an order's items.
   */
  async fetch(
    agentId: string,
    request: { name: string; path: string; query?: string; rows?: string },
  ): Promise<string> {
    const active = this.options.runOf(agentId)
    if (!this.options.reader) customFail('这个客户端不能按路径读取 ORYH，只能读任务列出的来源。')
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(request.name)) customFail('name 须以字母开头，只含字母、数字、_、-。')
    if (active.datasets.has(request.name) || active.loading.has(request.name))
      customFail(`数据集 ${request.name} 已经读过；换一个名字，或用 oryh_custom_page_read 翻页。`)
    if (active.datasets.size >= RUN_DATASETS) customFail(`一次运行最多 ${RUN_DATASETS} 个数据集。`)
    if (request.rows !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(request.rows))
      customFail('rows 须是字段名。')
    const query = Object.fromEntries(new URLSearchParams(request.query ?? ''))
    if ('page' in query || 'size' in query) customFail('不要给 page、size：列表由读取工具自己分页读完。')
    this.options.step(active, this.options.runText(active, `正在读取 ${request.path}…`, `Reading ${request.path}…`))
    await this.loadOnce(active, request.name, () =>
      this.readPath(active, request.name, request.path, query, request.rows),
    )
    this.options.step(
      active,
      this.options.runText(
        active,
        `已读取 ${request.path}，共 ${active.datasets.get(request.name)?.dataset.rows.length ?? 0} 条；AI 正在处理…`,
        `Read ${request.path}: ${active.datasets.get(request.name)?.dataset.rows.length ?? 0} records. Processing…`,
      ),
    )
    return this.page(active, request.name, 0, READ_PAGE)
  }

  private async loadOnce(active: ActiveRun, name: string, load: () => Promise<void>) {
    if (active.loading.has(name)) customFail('此数据集正在读取，请等待当前读取完成。')
    active.loading.add(name)
    try {
      await load()
    } finally {
      active.loading.delete(name)
      // What was coming in is now a dataset, or was not kept.
      active.reading = 0
    }
  }

  /** Count one ORYH request against the run's budget. */
  private countRequest(active: ActiveRun) {
    // Each request is a sign of life: the counts on the page move even while the step stays the same.
    this.options.step(active)
    if (++active.requests > RUN_REQUESTS)
      customFail(`本次运行读取 ORYH 已超过 ${RUN_REQUESTS} 次。请减少读取：先按条件筛选列表，再只读需要的详情。`)
  }

  /** Refuse a read whose rows would take the run past the rows it may hold in all. */
  private checkRows(active: ActiveRun, adding: number) {
    const held = [...active.datasets.values()].reduce((sum, entry) => sum + entry.dataset.rows.length, 0)
    if (held + adding > RUN_ROWS) customFail(`本次运行读取的记录已超过 ${RUN_ROWS} 条，请缩小范围。`)
  }

  private page(active: ActiveRun, name: string, offset: number, limit: number): string {
    const { dataset, read } = active.datasets.get(name)!
    const page: Record<string, string>[] = []
    let size = 0
    for (const row of dataset.rows.slice(offset, offset + limit)) {
      const object = { id: row.id, ...row.values }
      size += JSON.stringify(object).length
      if (page.length && size > READ_CHARS) break
      page.push(object)
    }
    return JSON.stringify({
      dataset: name,
      path: read.path,
      total: dataset.rows.length,
      fields: [...dataset.fields].slice(0, 120),
      firstFetchedAt: read.firstFetchedAt,
      fetchedAt: read.fetchedAt,
      notice: '分页读取，不保证事务快照；只可据此陈述可见记录。统计请用 oryh_custom_page_calculate。',
      offset,
      rows: page,
      ...(offset + page.length < dataset.rows.length ? { next: offset + page.length } : {}),
    })
  }

  private async readPath(
    active: ActiveRun,
    name: string,
    path: string,
    query: Record<string, string>,
    rowsField: string | undefined,
  ): Promise<void> {
    const scope = await this.options.scope(active.parent)
    if (scope.key !== active.scopeKey) customFail('身份已变化。')
    const connectionId = active.parent.connectionId as ConnectionId
    const items: CustomJson[] = []
    const ids = new Set<string>()
    // Discover pagination from the response. Some bare collections return all rows and
    // reject page/size; a collection-shaped path alone does not establish that contract.
    let paging: { page: number; size: number } | undefined
    let total: number | undefined
    let firstFetchedAt = ''
    let fetchedAt = ''
    let list = false
    for (let round = 0; round < 50; round++) {
      active.cancel.signal.throwIfAborted()
      this.countRequest(active)
      let body: unknown
      try {
        body = await this.options.reader!.read(connectionId, path, paging ? { ...query, ...paging } : query)
      } catch (error) {
        customFail(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      fetchedAt = new Date().toISOString()
      if (!firstFetchedAt) firstFetchedAt = fetchedAt
      const envelope = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
      const data = 'data' in envelope ? envelope.data : body
      let chunk: unknown
      if (rowsField) {
        const holder =
          data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>)[rowsField]
            : undefined
        if (!Array.isArray(holder)) customFail(`${path} 的回应里没有列表 ${rowsField}。`)
        chunk = holder
      } else chunk = Array.isArray(data) ? data : [data]
      const meta = envelope.meta as { page?: number; size?: number; pages?: number; total?: number } | undefined
      list ||= !rowsField && typeof meta?.page === 'number'
      const rows = chunk as CustomJson[]
      const expected = !rowsField && typeof meta?.total === 'number' ? meta.total : undefined
      if ((expected ?? items.length + rows.length) > MAX_ROWS)
        customFail(`${path} 有 ${expected ?? '超过 1000'} 条，超过每个数据集 ${MAX_ROWS} 条的上限，请加筛选条件。`)
      if (total !== undefined && expected !== undefined && expected !== total)
        customFail(`读取 ${path} 期间总量发生变化。`)
      total = expected
      this.checkRows(active, items.length + rows.length)
      for (const row of rows) {
        const id = row && typeof row === 'object' && !Array.isArray(row) ? row.id : undefined
        if (typeof id === 'string' && id) {
          if (ids.has(id)) customFail(`${path} 分页出现重复记录。`)
          ids.add(id)
        }
        items.push(row)
      }
      active.reading = items.length
      const pages = !rowsField && typeof meta?.pages === 'number' ? meta.pages : 1
      const current = !rowsField && typeof meta?.page === 'number' ? meta.page : (paging?.page ?? 1)
      if (current >= pages) break
      paging = { page: current + 1, size: paging?.size ?? (typeof meta?.size === 'number' ? meta.size : FETCH_PAGE) }
    }
    if (total !== undefined && items.length !== total) customFail(`${path} 没有完整读取。`)
    const checked = await this.options.scope(active.parent)
    if (checked.key !== active.scopeKey) customFail('身份已变化。')
    active.cancel.signal.throwIfAborted()
    const search = new URLSearchParams(query).toString()
    active.datasets.set(name, {
      dataset: jsonDataset(name, items),
      read: {
        collection: path.split('/')[1]!,
        name,
        path: search ? `${path}?${search}` : path,
        ...(list ? { list: true } : {}),
        total: items.length,
        firstFetchedAt,
        fetchedAt,
        // Enough to find the records again; a run of many reads would not fit in the page's store otherwise.
        ids: [...ids].slice(0, 100),
      },
    })
  }

  private async readSource(active: ActiveRun, source: CustomDefinition['task']['sources'][number]): Promise<void> {
    const collection = source.collection
    // The reads below are ORYH's own permission check; this one is for the enterprise and person.
    const scope = await this.options.scope(active.parent)
    if (scope.key !== active.scopeKey) customFail('身份已变化。')
    const rows: BusinessRecord[] = [],
      ids = new Set<string>()
    let total: number | undefined,
      pages: number | undefined,
      fetchedAt = '',
      firstFetchedAt = ''
    for (let number = 1; number <= 50; number++) {
      active.cancel.signal.throwIfAborted()
      this.countRequest(active)
      const result = await this.options.records.collectionList({
        connectionId: active.parent.connectionId,
        collection,
        page: number,
        filters: source.filters,
        display: displayOf(source),
      })
      if (result.total > MAX_ROWS || result.pages > 50) customFail('来源超出完整读取上限，请缩小筛选范围。')
      if (total !== undefined && (result.total !== total || result.pages !== pages))
        customFail('分页读取期间总量发生变化。')
      total = result.total
      pages = result.pages
      if (number === 1) firstFetchedAt = result.fetchedAt
      fetchedAt = result.fetchedAt
      for (const row of result.rows) {
        if (ids.has(row.id)) customFail('来源分页出现重复记录。')
        ids.add(row.id)
        rows.push(row)
      }
      active.reading = rows.length
      if (number >= result.pages) break
    }
    if (rows.length !== total) customFail('来源记录未完整读取。')
    this.checkRows(active, rows.length)
    const checked = await this.options.scope(active.parent)
    if (checked.key !== active.scopeKey) customFail('身份已变化。')
    active.cancel.signal.throwIfAborted()
    active.datasets.set(collection, {
      dataset: recordsDataset(source, rows),
      read: {
        collection,
        name: collection,
        path: `/${collection}`,
        list: true,
        total: rows.length,
        firstFetchedAt,
        fetchedAt,
        ids: [...ids],
      },
    })
  }

  async calculate(agentId: string, request: CalculationRequest): Promise<string> {
    const active = this.options.runOf(agentId)
    this.options.step(
      active,
      this.options.runText(active, `正在统计 ${request.collection}…`, `Counting ${request.collection}…`),
    )
    const entry = active.datasets.get(request.collection)
    if (!entry)
      customFail(
        `数据集 ${request.collection} 还没有读取：先用 oryh_custom_page_fetch，或用 oryh_custom_page_read 读任务来源。`,
      )
    const checked = await this.options.scope(active.parent)
    if (checked.key !== active.scopeKey) customFail('身份已变化。')
    active.cancel.signal.throwIfAborted()
    const others = new Map([...active.datasets].map(([name, other]) => [name, other.dataset] as const))
    return JSON.stringify(calculateRows(entry.dataset, request, { timeZone: active.definition.task.timeZone, others }))
  }

  /**
   * Exact arithmetic on figures the run already has, such as an order's line total plus its adjustments
   * from another source: the six-place decimals calculate uses, never the model's own addition.
   */
  arithmetic(agentId: string, operation: 'add' | 'subtract', values: readonly string[]): string {
    this.options.runOf(agentId)
    if (values.length < 2 || values.length > 100) customFail('须给 2 到 100 个数值。')
    const [first, ...rest] = values.map(value => decimal(value.replaceAll(',', '')))
    const total = rest.reduce((sum, value) => (operation === 'add' ? sum + value : sum - value), first!)
    return JSON.stringify({ operation, values, value: decimalText(total) })
  }

  publish(agentId: string, json: string): string {
    const active = this.options.runOf(agentId)
    this.options.step(
      active,
      this.options.runText(active, '正在校验并发布结果…', 'Validating and publishing the result…'),
    )
    if (active.definition.task.sources.some(s => !active.datasets.has(s.collection)))
      customFail('尚未读取所有任务来源。')
    let value: unknown
    try {
      value = JSON.parse(json)
    } catch {
      customFail('结果不是有效 JSON。')
    }
    active.result = validateResult(active.definition, value)
    return '结果格式已接收，仍需在任务结束后复核权限和版本才会发布。'
  }
}
