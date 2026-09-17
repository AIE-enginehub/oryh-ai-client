import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { pageById, requirePage } from '@oryh/ai-client-pages'
import {
  type OryhRecordRemote,
  type ProductOption,
  type RecordKind,
  recordColumns,
  recordSpecs,
} from '@oryh/ai-client-records'
import { currentPage, type PaneService, textOutput } from '@oryh/dsh-pane'
import type { UserViewSummary } from '@oryh/dsh-pane/types'

const fail = (text: string) => new OryhClientError(text, 'request-failed')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const RECORD_KINDS: readonly RecordKind[] = ['sales-orders', 'inventory-items', 'inventory-item-details', 'shipments']

/**
 * What the agent can do with the lists in the business pane: their display columns, their query
 * bars, and the menu entries a person adds over them. All of it is presentation; none of it writes
 * a business record.
 */
export class ListTools {
  constructor(
    private readonly ctx: Context,
    private readonly pane: PaneService,
    private readonly records: OryhRecordRemote,
  ) {}

  /** The list page on screen, when it is one of the record lists and shows its list rather than a record. */
  private recordList(sessionId: string) {
    const page = currentPage(this.pane, sessionId)
    const kind = page.page as RecordKind
    if (!Object.hasOwn(recordSpecs, kind) || page.context?.key !== `${kind}:list`) return undefined
    return { page, kind }
  }

  async configureRecordColumns(sessionId: string, columns: string[], signal: AbortSignal): Promise<string> {
    const list = this.recordList(sessionId)
    if (!list) throw fail('请先打开销售订单、库存或收发货列表。')
    const { kind } = list
    const allowed = recordColumns(kind)
    if (
      !columns.length ||
      columns.length > Object.keys(allowed).length ||
      new Set(columns).size !== columns.length ||
      columns.some(c => !Object.hasOwn(allowed, c))
    )
      throw fail('列配置无效，请选择当前列表支持的字段，至少保留一列。')
    return this.pane.issue<string>(
      sessionId,
      { lane: 'navigation', page: kind, payload: { target: 'columns', page: kind, columns }, timeoutMs: 10_000 },
      id => ({
        invalid: () => {
          const now = this.pane.session(sessionId)
          return now?.page !== kind || now.context?.key !== `${kind}:list` ? '页面已变化，请重新读取。' : undefined
        },
        until: () =>
          this.pane.acked(sessionId, id) && same(this.pane.session(sessionId)?.context?.columns, columns)
            ? '当前列表显示列已更新，未修改业务记录。'
            : undefined,
        expired: '页面未确认列配置，请重新读取。',
        signal,
      }),
    )
  }

  /**
   * Configure the query bar of the list on screen: which extra query fields it shows, and optionally
   * the values to fill in and apply.
   *
   * The fields a list may be queried by are the ones its ORYH endpoint declares, read from the
   * deployment — not a list in this client. When a person asks for a field the endpoint does not
   * declare, the refusal says so plainly: ORYH does not support querying by it. That wording matters,
   * because the model otherwise fills the gap with a workaround that does not exist, such as
   * filtering on the page. Inventory movements also accept `product_code`, a query this client
   * composes from inventory items.
   */
  async configureQueryFields(
    sessionId: string,
    fields: string[],
    values: readonly { field: string; value: string }[] | undefined,
    productCode: string | undefined,
    signal: AbortSignal,
    productIds?: string[],
  ): Promise<string> {
    const list = this.recordList(sessionId)
    if (!list) throw fail('请先打开销售订单、库存余额、库存流水或收发货列表，并退出详情。')
    const { page, kind } = list
    if (page.context?.view)
      throw fail(`“${page.context.view.label}”是用户菜单项，筛选条件固定；如需不同条件请新建菜单项。`)
    const { connection, session } = await this.pane.verified(sessionId)
    requirePage(connection.identity, kind)
    const title = pageById(kind)?.title ?? kind
    const searchField = recordSpecs[kind].query
    const declared = (await this.records.recordFilterFields(session.connectionId, kind))
      .map(f => f.name)
      .filter(name => name !== searchField)
    const allowed = [...(kind === 'inventory-item-details' ? ['product_code'] : []), ...declared]
    if (!Array.isArray(fields) || fields.some(f => typeof f !== 'string') || new Set(fields).size !== fields.length)
      throw fail('查询字段配置无效。')
    const unsupported = fields.filter(f => !allowed.includes(f))
    if (unsupported.length)
      throw fail(
        `ORYH 目前不支持按“${unsupported.join('”“')}”查询${title}：该列表接口没有声明这个查询参数。可用的查询字段：${allowed.join('、') || '无'}。请如实告诉用户服务端暂不支持，不要建议在页面上自行筛选。`,
      )
    if (
      productCode !== undefined &&
      (typeof productCode !== 'string' || productCode.length > 200 || !fields.includes('product_code'))
    )
      throw fail('产品编码只能在显示“产品”查询字段时填写。')
    if (
      productIds !== undefined &&
      (!Array.isArray(productIds) ||
        productIds.length > 50 ||
        productIds.some(v => typeof v !== 'string' || !v || v.length > 200) ||
        new Set(productIds).size !== productIds.length ||
        productCode !== undefined ||
        !fields.includes('product_code'))
    )
      throw fail('产品选择无效。')
    let queryValues: Record<string, string> | undefined
    if (values !== undefined) {
      if (
        !Array.isArray(values) ||
        values.some(
          v => typeof v?.field !== 'string' || typeof v?.value !== 'string' || !v.value || v.value.length > 200,
        )
      )
        throw fail('查询值无效：每项需有字段和非空的值。')
      const misplaced = values.filter(v => v.field === 'product_code' || !fields.includes(v.field))
      if (misplaced.length)
        throw fail(
          `查询值必须对应已显示的查询字段（产品请用 productIds 或 productCode）：${misplaced.map(v => v.field).join('、')}。`,
        )
      const filled: Record<string, string> = Object.fromEntries(values.map(v => [v.field, v.value]))
      if (Object.keys(filled).length !== values.length) throw fail('同一查询字段只能填一个值。')
      queryValues = filled
    }
    let products: ProductOption[] | undefined
    if (productIds !== undefined)
      products = (
        await this.records.productSearch({ connectionId: session.connectionId, query: '', page: 1, ids: productIds })
      ).rows
    else if (productCode !== undefined) {
      if (!productCode.trim()) products = []
      else {
        const found = await this.records.productSearch({
          connectionId: session.connectionId,
          query: productCode.trim(),
          page: 1,
        })
        products = found.rows.filter(v => v.code === productCode.trim())
        if (products.length !== 1) throw fail('未找到唯一匹配的产品，请先搜索并选择产品。')
      }
    }
    // A value of the wrong type is refused by the records service; finding out here, before the page is
    // told, gives the model a precise error instead of a page that silently shows one.
    let rows: number | undefined
    if (queryValues && Object.keys(queryValues).length && !products?.length)
      rows = (
        await this.records.recordList({
          connectionId: session.connectionId,
          kind,
          page: 1,
          query: '',
          filters: queryValues,
        })
      ).total
    if (this.pane.session(sessionId)?.revision !== page.revision) throw fail('页面已变化，请重新读取。')
    const expectedIds = products?.map(v => v.id)
    return this.pane.issue<string>(
      sessionId,
      {
        lane: 'navigation',
        page: kind,
        payload: {
          target: 'filters',
          page: kind,
          queryFields: fields,
          ...(queryValues ? { queryValues } : {}),
          ...(products ? { products, productIds: products.map(v => v.id) } : {}),
        },
        timeoutMs: 10_000,
      },
      id => ({
        invalid: () => {
          const now = this.pane.session(sessionId)
          return now?.page !== kind || now.context?.key !== page.context?.key ? '页面已变化，请重新读取。' : undefined
        },
        until: () => {
          const now = this.pane.session(sessionId)?.context
          const applied =
            this.pane.acked(sessionId, id) &&
            same(now?.queryFields, fields) &&
            (queryValues === undefined || same(now?.queryValues ?? {}, queryValues)) &&
            (expectedIds === undefined || same(now?.productIds, expectedIds))
          return applied
            ? `${title}查询栏已更新${rows !== undefined ? `，按所填条件共 ${rows} 条` : ''}。若填写了产品或查询值，查询已发起；请读取当前页面的 loading、error 和结果确认。`
            : undefined
        },
        expired: '页面未确认查询栏配置，请重新读取。',
        signal,
      }),
    )
  }

  /**
   * Add a menu entry the person asked for: one existing list, narrowed by server-side filters, saved in
   * the Harness workspace this session belongs to.
   *
   * The list is read once with the filters before anything is saved. That read is the validation —
   * the records service refuses a key the endpoint does not declare — and it tells the model how many
   * rows the entry holds, so an empty result is noticed rather than shipped. The write is durable on
   * return; the page learns of it from the pane stream, so no page needs to be open for this to succeed.
   */
  async addUserView(
    sessionId: string,
    label: string,
    kind: string,
    filters: readonly { field: string; value: string }[],
  ): Promise<string> {
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    if (!Object.hasOwn(recordSpecs, kind))
      throw fail('菜单项只能建在已有列表之上：销售订单、库存余额、库存流水或收发货。')
    const list = kind as RecordKind
    const { connection } = await this.pane.verified(sessionId)
    requirePage(connection.identity, list)
    const name = String(label ?? '').trim()
    if (!name || name.length > 24) throw fail('菜单名称需为 1–24 个字。')
    if (!Array.isArray(filters) || filters.some(f => typeof f?.field !== 'string' || typeof f?.value !== 'string'))
      throw fail('筛选条件格式无效。')
    const conditions = Object.fromEntries(filters.map(f => [f.field, f.value]))
    if (Object.keys(conditions).length !== filters.length) throw fail('同一字段只能出现一次。')
    const probe = await this.records.recordList({
      connectionId: home.connectionId,
      kind: list,
      page: 1,
      query: '',
      filters: conditions,
    })
    if (this.pane.session(sessionId)?.scope !== home.scope) throw fail('企业页面已改变。')
    const view: UserViewSummary = { id: randomUUID(), label: name, kind: list, filters: conditions }
    const views = await this.pane.userViews.add(sessionId, home.scope, view)
    this.pane.setMenu(sessionId, views)
    return JSON.stringify({
      added: view,
      rows: probe.total,
      notice:
        probe.total === 0
          ? '按这些条件当前没有记录。请确认字段取值是否正确，必要时删除重建。'
          : '菜单项已添加，保存在当前会话所在的 workspace。',
    })
  }

  async removeUserView(sessionId: string, userViewId: string): Promise<string> {
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    const removed = await this.pane.userViews.remove(sessionId, home.scope, userViewId)
    if (!removed) throw fail('没有这个菜单项，请先读取当前页面的 userMenu。')
    await this.pane.refreshMenu(sessionId)
    return `已删除菜单项“${removed.label}”，未修改任何业务记录。`
  }

  /** Open a menu entry the person made, and wait until the page shows it. */
  async openUserView(sessionId: string, userViewId: string, signal: AbortSignal): Promise<string> {
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    const view = (await this.pane.refreshMenu(sessionId)).find(v => v.id === userViewId)
    if (!view) throw fail('没有这个菜单项，请先读取当前页面的 userMenu。')
    const { connection } = await this.pane.verified(sessionId)
    requirePage(connection.identity, view.kind)
    if (this.pane.session(sessionId)?.context?.view?.id === userViewId)
      return JSON.stringify(currentPage(this.pane, sessionId))
    // The command names the list the entry narrows, so a page sync can tell it apart without a lookup.
    return this.pane.issue<string>(
      sessionId,
      {
        lane: 'navigation',
        page: view.kind,
        payload: { target: 'view', page: view.kind, userViewId },
        timeoutMs: 15_000,
      },
      id => ({
        invalid: () => (this.pane.session(sessionId)?.scope !== home.scope ? '页面导航已取消。' : undefined),
        until: () =>
          this.pane.acked(sessionId, id) && this.pane.session(sessionId)?.context?.view?.id === userViewId
            ? JSON.stringify(currentPage(this.pane, sessionId))
            : undefined,
        expired: '网页未确认导航，请重新读取当前页面。',
        signal,
      }),
    )
  }

  install(): void {
    const { ctx } = this
    ctx.tools.register(
      defineTool({
        name: 'oryh_search_products',
        description: '按产品名称或编码搜索真实产品供多选查询使用，返回编号、名称、编码和分页；重名时请用户选择。',
        parameters: { query: { type: 'string', required: true }, page: { type: 'integer' } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          const id = String(exec.agent.id)
          const session = this.pane.page(id)
          const result = await this.records.productSearch({
            connectionId: session.connectionId,
            query: args.query,
            page: args.page ?? 1,
          })
          if (this.pane.session(id)?.scope !== session.scope) throw new Error('企业会话已改变')
          exec.signal.throwIfAborted()
          return JSON.stringify(result)
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_record_query',
        description:
          '配置当前列表（销售订单、库存余额、库存流水、收发货）的查询工具栏，不是显示列。fields 为要显示的额外查询字段的完整集合，只能取 ORYH 该列表接口声明的查询参数（先用 oryh_record_filter_fields 查看）；库存流水另外支持 product_code 产品（多选）。空数组移除全部额外查询字段。values 为要填入并立即查询的值。用户要的字段不在可用范围内时，如实告诉用户 ORYH 目前不支持按该字段查询，不要建议在页面上自行筛选或用其它办法绕开。产品：先用 oryh_search_products 搜索再传 productIds 完整数组（并集），或传精确 productCode；两者不同传。',
        parameters: {
          fields: { type: 'array', required: true, items: { type: 'string' } },
          values: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { field: { type: 'string', required: true }, value: { type: 'string', required: true } },
            },
          },
          productCode: { type: 'string' },
          productIds: { type: 'array', items: { type: 'string' } },
        },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.configureQueryFields(
            String(exec.agent.id),
            args.fields,
            args.values,
            args.productCode,
            exec.signal,
            args.productIds,
          )
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_record_columns',
        description:
          '调整当前销售订单、库存余额、库存流水或 Shipment 列表的显示列和顺序。先读取当前页面 availableColumns；至少保留一列。只改变显示，不修改数据。',
        parameters: { columns: { type: 'array', required: true, items: { type: 'string' } } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.configureRecordColumns(String(exec.agent.id), args.columns, exec.signal)
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_record_filter_fields',
        description:
          '读取某个列表在当前部署上可以按哪些字段筛选（来自 ORYH 自己的接口说明）。新增菜单项前先调用，只能用这里返回的字段。只读。',
        parameters: { kind: { type: 'string', required: true, enum: [...RECORD_KINDS] } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          const home = this.pane.session(String(exec.agent.id))
          if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
          return JSON.stringify(await this.records.recordFilterFields(home.connectionId, args.kind as RecordKind))
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_menu_add',
        description:
          '按用户要求在左侧菜单新增一个菜单项：在已有列表上加服务端筛选条件，并用用户起的名字显示，例如“入库单”= 收发货列表里方向为入库的记录。先用 oryh_record_filter_fields 确认字段，字段取值以 ORYH 的 skill 或接口说明为准，不要猜。只改菜单显示，不修改业务数据；保存在当前会话所在的 workspace。',
        parameters: {
          label: { type: 'string', required: true, description: '用户起的菜单名称，1–24 个字' },
          kind: { type: 'string', required: true, enum: [...RECORD_KINDS] },
          filters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { field: { type: 'string', required: true }, value: { type: 'string', required: true } },
            },
          },
        },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.addUserView(String(exec.agent.id), args.label, args.kind, args.filters)
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_menu_remove',
        description: '删除用户自己添加的菜单项。userViewId 取自 oryh_current_page 返回的 userMenu。不修改业务数据。',
        parameters: { userViewId: { type: 'string', required: true } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.removeUserView(String(exec.agent.id), args.userViewId)
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_open_view',
        description:
          '打开用户自己添加的菜单项并等待页面回执。userViewId 取自 oryh_current_page 返回的 userMenu。只导航，不写入业务数据。',
        parameters: { userViewId: { type: 'string', required: true } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.openUserView(String(exec.agent.id), args.userViewId, exec.signal)
        },
      }),
    )
  }
}
