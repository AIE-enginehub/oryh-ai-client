import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { listPageForCollection, pageById, requirePage } from '@oryh/ai-client-pages'
import {
  type OryhRecordRemote,
  type ProductOption,
  type RecordDisplay,
  type RecordKind,
  recordColumns,
  recordSpecs,
} from '@oryh/ai-client-records'
import { currentPage, type PaneService, reveal, SHOW_PARAMETER, textOutput } from '@oryh/dsh-pane'
import type { UserViewSummary } from '@oryh/dsh-pane/types'

const fail = (text: string) => new OryhClientError(text, 'request-failed')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What the agent can do with the lists in the business pane: their display columns, their query
 * bars, and the menu entries a person adds over them. All of it is presentation; none of it writes
 * a business record.
 */
/** How long a role's menu serves before it is read again: permissions change rarely, and a sign-in resets it. */
const ROLE_MENU_TTL_MS = 10 * 60_000

/** A stable id for a role entry, shaped like a menu entry's, so the page routes both the same way. */
function roleViewId(collection: string, filters: Record<string, string>): string {
  const hex = createHash('sha256')
    .update(`role|${collection}|${JSON.stringify(filters)}`)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export class ListTools {
  /** Each enterprise identity's role menu, read once and republished when it arrives. */
  private readonly roleMenus = new Map<
    string,
    { at: number; views?: UserViewSummary[]; loading?: Promise<UserViewSummary[]> }
  >()

  constructor(
    private readonly ctx: Context,
    private readonly pane: PaneService,
    private readonly records: OryhRecordRemote,
  ) {}

  /**
   * The menu this session's identity's permissions imply, if it has been read (`records.roleViews`).
   *
   * Read in the background the first time a frame asks, and published by asking the pane to send another
   * frame. A collection a page of this client already shows — its own list, or the narrowing a page
   * makes of it — is left out, so the role adds what is missing and repeats nothing.
   * @param sessionId - the bound session.
   * @returns the entries, or undefined until they have been read once.
   */
  roleViews(sessionId: string): UserViewSummary[] | undefined {
    const session = this.pane.session(sessionId)
    if (!session) return undefined
    const known = this.roleMenus.get(session.scope)
    const fresh = known?.views !== undefined && Date.now() - known.at < ROLE_MENU_TTL_MS
    if (!fresh && !known?.loading) {
      const scope = session.scope
      void this.roleMenu(session.connectionId, scope).then(() => {
        if (this.pane.session(sessionId)?.scope === scope) this.pane.changed(sessionId)
      })
    }
    return known?.views
  }

  /**
   * One enterprise identity's role menu, read at most once per `ROLE_MENU_TTL_MS` whoever asks: a
   * session's frame, or a workbench with no session open (`PaneService.connectionMenu`).
   * @param connectionId - a connection of this identity.
   * @param scope - the identity, as the pane scopes it.
   * @returns the entries; empty when the menu cannot be built.
   */
  roleMenu(connectionId: string, scope: string): Promise<UserViewSummary[]> {
    const known = this.roleMenus.get(scope)
    if (known?.views !== undefined && Date.now() - known.at < ROLE_MENU_TTL_MS) return Promise.resolve(known.views)
    if (known?.loading) return known.loading
    // Inside the chain, so even a synchronous failure reads as "no role entries": the menu is extra,
    // and a frame the pane cannot build would take the whole workbench down with it.
    const loading = Promise.resolve()
      .then(() => this.records.roleViews(connectionId))
      .then(
        views =>
          views
            .filter(view => this.pane.pageOf(view.collection) === undefined)
            .map(view => ({ id: roleViewId(view.collection, view.filters), origin: 'role' as const, ...view })),
        () => [] as UserViewSummary[],
      )
      .then(views => {
        this.roleMenus.set(scope, { at: Date.now(), views })
        return views
      })
    this.roleMenus.set(scope, { at: known?.at ?? 0, ...(known?.views ? { views: known.views } : {}), loading })
    return loading
  }

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
    const { kind, page } = list
    const captured = this.pane.home(sessionId)
    const { connection } = await this.pane.verified(sessionId)
    requirePage(connection.identity, kind)
    this.pane.assertUnchanged(sessionId, captured, '页面已变化，请重新读取。')
    if (currentPage(this.pane, sessionId).context?.view?.id !== page.context?.view?.id)
      throw fail('页面已变化，请重新读取。')
    const userViewId = page.context?.view?.id
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
      {
        lane: 'navigation',
        page: kind,
        payload: { target: 'columns', page: kind, columns, ...(userViewId ? { userViewId } : {}) },
        timeoutMs: 10_000,
      },
      id => ({
        invalid: () => {
          const now = this.pane.session(sessionId)
          return now?.page !== kind || now.context?.key !== `${kind}:list` || now.context?.view?.id !== userViewId
            ? '页面已变化，请重新读取。'
            : undefined
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
    collection: string,
    filters: readonly { field: string; value: string }[],
    columns?: readonly { field: string; label: string }[],
    titleField?: string,
  ): Promise<string> {
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    if (typeof collection !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(collection))
      throw fail('集合名称无效：用 ORYH 自己的集合名，例如 sales-order-items。')
    const { connection } = await this.pane.verified(sessionId)
    const name = String(label ?? '').trim()
    if (!name || name.length > 24) throw fail('菜单名称需为 1–24 个字。')
    if (!Array.isArray(filters) || filters.some(f => typeof f?.field !== 'string' || typeof f?.value !== 'string'))
      throw fail('筛选条件格式无效。')
    const conditions = Object.fromEntries(filters.map(f => [f.field, f.value]))
    if (Object.keys(conditions).length !== filters.length) throw fail('同一字段只能出现一次。')
    const display = await this.displayFor(home.connectionId, collection, columns, titleField)
    // The probe is the only check that this collection exists at all: the deployment answers, not a
    // list kept here. It also reports how many rows the entry holds, so an empty one is noticed.
    const probe = await this.records.collectionList({
      connectionId: home.connectionId,
      collection,
      page: 1,
      filters: conditions,
      display,
    })
    if (this.pane.session(sessionId)?.scope !== home.scope) throw fail('企业页面已改变。')
    const view: UserViewSummary = { id: randomUUID(), label: name, collection, filters: conditions, display }
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

  /**
   * How a menu entry's list is shown: which field titles a row, and the columns under the names a
   * person reads.
   *
   * The structure is the deployment's — the fields its schema declares for that collection, in the
   * order the object declares them. The names are the agent's: an OpenAPI document carries
   * `Product Name Snapshot`, never 产品名称, and what a column should be called in this company's
   * words is a reading of the business (ADR-0010). A column the agent names over a field the schema
   * does not have is refused; where the schema declares nothing at all — a route with no response
   * model — the agent has seen the rows and its columns are taken as given.
   * @param connectionId - the session's connection.
   * @param collection - collection as ORYH names it.
   * @param columns - what the agent asked to show, if anything.
   * @param titleField - the field whose value titles a row, if the agent chose one.
   */
  private async displayFor(
    connectionId: string,
    collection: string,
    columns?: readonly { field: string; label: string }[],
    titleField?: string,
  ): Promise<RecordDisplay> {
    const declared = await this.records.collectionRowFields(connectionId, collection).catch(() => [])
    const known = new Set(declared.map(f => f.name))
    if (columns !== undefined) {
      if (!Array.isArray(columns) || !columns.length) throw fail('列定义格式无效。')
      // An entry over one of the four built-in lists is drawn by that list, which shows its own columns and
      // no others. Taken here, a column it lacks was saved, dropped on screen for one nobody asked for, and
      // the person was asked about it only after the entry existed.
      if (Object.hasOwn(recordSpecs, collection)) {
        const shown = recordColumns(collection as RecordKind)
        const missing = columns.filter(c => !Object.hasOwn(shown, c?.field))
        if (missing.length)
          throw fail(
            `${collection} 的列表只能显示这些列：${Object.keys(shown).join('、')}；${missing.map(c => c?.field).join('、')} 不能作为它的列。菜单项还没有添加：先问用户这些列怎么处理（去掉，或改做自定义页面），再按他的选择添加。`,
          )
      }
      const unknown = columns.filter(c => known.size > 0 && !known.has(c?.field))
      if (unknown.length)
        throw fail(
          `这些字段不在该列表的返回内容里：${unknown.map(c => c?.field).join('、')}。可用字段：${[...known].join('、') || '（该接口未声明返回结构，请先读一页数据再定列）'}。`,
        )
      const shown = columns.map(c => ({ field: String(c.field), label: String(c.label || c.field) }))
      if (new Set(shown.map(c => c.field)).size !== shown.length) throw fail('同一字段只能作为一列。')
      return {
        columns: shown,
        ...(titleField && (known.size === 0 || known.has(titleField)) ? { title: titleField } : {}),
      }
    }
    // Nobody named the columns: show what the rows carry, under the field names, rather than nothing.
    if (!declared.length) throw fail('该接口没有声明返回结构，请先读一页数据，再带着列名重新添加。')
    const shown = declared.filter(f => f.name !== 'id').slice(0, 12)
    return {
      columns: shown.map(f => ({ field: f.name, label: f.name })),
      ...(titleField && known.has(titleField) ? { title: titleField } : {}),
    }
  }

  async removeUserView(sessionId: string, userViewId: string): Promise<string> {
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    if (this.roleViews(sessionId)?.some(v => v.id === userViewId))
      throw fail('这个菜单项来自你在 ORYH 的权限，不能删除；权限变了它会跟着变。')
    const shared = this.ctx.get('oryhSharedViews')
    if (shared?.views().some(v => v.id === userViewId))
      throw fail('这个菜单项是同事共享的，不能删除；共享的人取消共享后它会消失。')
    const view = (await this.pane.userViews.list(sessionId, home.scope)).find(v => v.id === userViewId)
    if (!view) throw fail('没有这个菜单项，请先读取当前页面的 userMenu。')
    // Keep the local entry recoverable if withdrawal fails; the library is the authority, not its cache.
    const wasShared = await shared?.forget(userViewId, 'menu')
    const removed = await this.pane.userViews.remove(sessionId, home.scope, userViewId)
    if (!removed) throw fail('菜单项已变化，请重新读取。')
    await this.pane.refreshMenu(sessionId)
    return `已删除菜单项“${removed.label}”${wasShared ? '，同时取消了对同事的共享' : ''}，未修改任何业务记录。`
  }

  /** Open a menu entry the person made, and wait until the page shows it. */
  async openUserView(sessionId: string, userViewId: string, signal: AbortSignal, show = false): Promise<string> {
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    const view =
      (await this.pane.refreshMenu(sessionId)).find(v => v.id === userViewId) ??
      this.roleViews(sessionId)?.find(v => v.id === userViewId) ??
      this.ctx
        .get('oryhSharedViews')
        ?.views()
        .find(v => v.id === userViewId)
    if (!view) throw fail('没有这个菜单项，请先读取当前页面的 userMenu。')
    const { connection } = await this.pane.verified(sessionId)
    if (this.pane.session(sessionId)?.context?.view?.id === userViewId)
      return JSON.stringify(currentPage(this.pane, sessionId))
    // The command names the built-in page when the entry narrows one, so a page sync can tell it apart
    // without a lookup; an entry over any other collection is shown by the generic list.
    const page = listPageForCollection(view.collection)
    return this.pane.issue<string>(
      sessionId,
      {
        lane: 'navigation',
        page,
        payload: { target: 'view', page, userViewId, ...reveal(show) },
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
    ctx.effect(
      () =>
        this.pane.provideState(sessionId => {
          const roleViews = this.roleViews(sessionId)
          return roleViews ? { roleViews } : {}
        }),
      'oryh role views state',
    )
    ctx.effect(
      () => this.pane.provideMenu((connectionId, scope) => this.roleMenu(connectionId, scope)),
      'oryh role menu',
    )
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
          '读取某个集合在当前部署上可以按哪些字段筛选、以及它的行有哪些字段（都来自 ORYH 自己的接口说明）。新增菜单项前先调用：筛选只能用 filters 里返回的字段，列只能用 rows 里返回的字段。collection 用 ORYH 自己的集合名（销售订单是 sales-orders，订单项是 sales-order-items）；不确定有哪些集合时，先用 ORYH 的 builtin_object_types 工具查。只读。',
        parameters: { collection: { type: 'string', required: true } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          const home = this.pane.session(String(exec.agent.id))
          if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
          const collection = String(args.collection)
          const [filters, rows] = await Promise.all([
            this.records.collectionFilterFields(home.connectionId, collection),
            this.records.collectionRowFields(home.connectionId, collection).catch(() => []),
          ])
          return JSON.stringify({
            filters,
            rows,
            ...(rows.length
              ? {}
              : { notice: '这个接口没有声明返回结构，先读一页数据看看行里有哪些字段，再带着列名新增菜单项。' }),
          })
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_menu_add',
        description:
          '按用户要求在左侧菜单新增一个菜单项：显示 ORYH 的某个集合，可加服务端筛选条件，用用户起的名字显示。例如“订单项”= sales-order-items 的全部记录，“入库单”= shipments 里方向为入库的记录。collection 用 ORYH 自己的集合名，不确定时先用 ORYH 的 builtin_object_types 工具查；先用 oryh_record_filter_fields 确认可筛选字段与行字段，字段取值以 ORYH 的 skill 或接口说明为准，不要猜。columns 是要显示的列和列名：列名用用户和这家公司的说法（接口里只有英文字段名），顺序就是显示顺序；不传则按接口声明的字段名显示。只改菜单显示，不修改业务数据；保存在当前会话所在的 workspace。',
        parameters: {
          label: { type: 'string', required: true, description: '用户起的菜单名称，1–24 个字' },
          collection: { type: 'string', required: true, description: 'ORYH 的集合名，例如 sales-order-items' },
          filters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { field: { type: 'string', required: true }, value: { type: 'string', required: true } },
            },
          },
          columns: {
            type: 'array',
            description: '要显示的列，按显示顺序；label 用中文业务说法',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { field: { type: 'string', required: true }, label: { type: 'string', required: true } },
            },
          },
          titleField: { type: 'string', description: '用哪个字段的值作为每行的标题，默认用编号' },
        },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.addUserView(
            String(exec.agent.id),
            args.label,
            args.collection,
            args.filters,
            args.columns,
            args.titleField,
          )
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
        name: 'oryh_menu_share',
        description:
          '把用户自己添加的菜单项或自己的自定义页面共享给本企业的同事，或取消共享（shared 为 false）。只共享做法（菜单项的集合、筛选条件、显示列；页面的定义），不共享数据：同事打开时各自按自己的 ORYH 权限读。userViewId 取自 oryh_current_page 返回的 userMenu（带 shared: true 的是已共享的），自定义页面用它的页面 id。只有用户明确要求共享或取消共享时才调用。不修改业务数据。',
        parameters: {
          userViewId: { type: 'string', required: true },
          shared: { type: 'boolean', required: true, description: 'true 共享给同事，false 取消共享' },
        },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.ctx.oryhSharedViews.share(String(exec.agent.id), args.userViewId, args.shared === true)
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_menu_copy',
        description:
          '把同事共享的菜单项或自定义页面复制一份成用户自己的，之后用户可以自己改，与同事的那一份互不影响。sharedViewId 取自 oryh_current_page 返回的 userMenu 里带 sharedBy 的项。复制的是页面时返回 pageId：它还没有数据，要用 oryh_custom_page_run 刷新一次才会出现在菜单里。不修改业务数据。',
        parameters: { sharedViewId: { type: 'string', required: true } },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          const copy = await this.ctx.oryhSharedViews.copy(String(exec.agent.id), args.sharedViewId)
          return JSON.stringify(
            copy.kind === 'page'
              ? {
                  copied: true,
                  pageId: copy.id,
                  title: copy.label,
                  note: '已复制成用户自己的自定义页面；它还没有数据，刷新一次后才会出现在菜单里。',
                }
              : { copied: true, userViewId: copy.id, label: copy.label },
          )
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'oryh_open_view',
        description:
          '打开菜单里的一项并等待页面回执：用户自己添加的，或同事共享的。userViewId 取自 oryh_current_page 返回的 userMenu。只导航，不写入业务数据。',
        parameters: { userViewId: { type: 'string', required: true }, show: SHOW_PARAMETER },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.openUserView(String(exec.agent.id), args.userViewId, exec.signal, args.show === true)
        },
      }),
    )
  }
}
