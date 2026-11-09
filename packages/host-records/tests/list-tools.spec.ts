import type { OryhRecordRemote } from '@oryh/ai-client-records'
import { currentPage, PaneService, SharedViews, UserViewRegistry } from '@oryh/dsh-pane'
import {
  connectionId,
  fakeContext,
  fakeController,
  fakeLibrary,
  paneSyncer,
  pending,
  tempDirectory,
  until,
  vi,
} from '@oryh/dsh-pane/testing'
import type { NavigationCommand } from '@oryh/dsh-pane/types'
import { describe, expect, it } from 'vitest'
import { ListTools } from '../src/list-tools.js'

/** What `GET /inventory-item-details` declares on a real deployment: no effective-date parameter. */
const detailFields = [
  { name: 'inventory_item_id', type: 'string' },
  { name: 'reason', type: 'string' },
  { name: 'entity_type', type: 'string' },
  { name: 'include_archived_items', type: 'boolean' },
]
const emptyList = async () => ({ rows: [], page: 1, pages: 1, total: 4, fetchedAt: 'now' })

async function setup(records: Partial<OryhRecordRemote> = {}) {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const pane = new PaneService(
    harness.ctx,
    fakeController().controller,
    temp.directory,
    new UserViewRegistry(harness.ctx),
  )
  const lists = new ListTools(harness.ctx, pane, records as OryhRecordRemote)
  lists.install()
  const exec = { agent: { id: 's' }, signal: new AbortController().signal }
  return {
    ...harness,
    pane,
    lists,
    exec,
    page: paneSyncer(pane),
    bind: () => pane.bind({ sessionId: 's', connectionId }),
    navigation: () => pending(pane) as NavigationCommand | undefined,
    close: temp.close,
  }
}

describe('display columns', () => {
  for (const kind of ['sales-orders', 'inventory-items', 'inventory-item-details', 'shipments'] as const) {
    it(`updates ${kind} columns through acknowledged navigation`, async () => {
      const f = await setup()
      try {
        await f.bind()
        const context = { key: `${kind}:list`, title: kind, detail: '', scope: '', columns: ['id'] }
        f.page.sync(kind, context)
        for (const columns of [[], ['password'], ['__proto__'], ['id', 'id']])
          await expect(f.lists.configureRecordColumns('s', columns, new AbortController().signal)).rejects.toThrow(
            /列配置/,
          )
        const changing = f.lists.configureRecordColumns('s', ['id'], new AbortController().signal)
        await until(() => f.navigation() !== undefined)
        expect(f.navigation()?.payload).toMatchObject({ target: 'columns', page: kind, columns: ['id'] })
        f.page.ack('navigation', kind, context)
        expect(await changing).toContain('显示列已更新')
        const cancelled = f.lists.configureRecordColumns('s', ['id'], new AbortController().signal)
        await until(() => f.navigation() !== undefined)
        f.page.sync('analytics')
        await expect(cancelled).rejects.toThrow(/页面已变化/)
        await expect(f.lists.configureRecordColumns('s', ['id'], new AbortController().signal)).rejects.toThrow(/列表/)
      } finally {
        await f.close()
      }
    })
  }
})

describe('the query bar', () => {
  it('offers query fields the list endpoint declares, and the product query on inventory movements', async () => {
    const f = await setup({ recordFilterFields: async () => detailFields, recordList: emptyList })
    try {
      await f.bind()
      const context = {
        key: 'inventory-item-details:list',
        title: '库存流水',
        detail: '',
        scope: '',
        queryFields: [] as string[],
      }
      f.page.sync('inventory-item-details', context)
      const configuring = f.lists.configureQueryFields(
        's',
        ['product_code', 'reason'],
        [{ field: 'reason', value: 'sale' }],
        undefined,
        new AbortController().signal,
      )
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({
        target: 'filters',
        page: 'inventory-item-details',
        queryFields: ['product_code', 'reason'],
        queryValues: { reason: 'sale' },
      })
      f.page.ack('navigation', 'inventory-item-details', {
        ...context,
        queryFields: ['product_code', 'reason'],
        queryValues: { reason: 'sale' },
      })
      const receipt = await configuring
      expect(receipt).toContain('查询栏已更新')
      expect(receipt).toContain('共 4 条')
    } finally {
      await f.close()
    }
  })
  it('says plainly that ORYH does not support a field the endpoint does not declare', async () => {
    const f = await setup({ recordFilterFields: async () => detailFields })
    try {
      await f.bind()
      f.page.sync('inventory-item-details', {
        key: 'inventory-item-details:list',
        title: '库存流水',
        detail: '',
        scope: '',
        queryFields: [],
      })
      const refusal = () =>
        f.lists.configureQueryFields('s', ['effective_at'], undefined, undefined, new AbortController().signal)
      await expect(refusal()).rejects.toThrow(/ORYH 目前不支持按“effective_at”查询库存流水/)
      await expect(refusal()).rejects.toThrow(/不要建议在页面上自行筛选/)
      // The search box already owns its field, so it is not offered twice.
      await expect(
        f.lists.configureQueryFields('s', ['inventory_item_id'], undefined, undefined, new AbortController().signal),
      ).rejects.toThrow(/不支持/)
      // A value must belong to a field that is shown.
      await expect(
        f.lists.configureQueryFields(
          's',
          ['reason'],
          [{ field: 'entity_type', value: 'x' }],
          undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/已显示的查询字段/)
      expect(f.navigation()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('hydrates multi-product selections before sending them to the page', async () => {
    const products = [
      { id: 'a', name: 'Product A', code: 'A' },
      { id: 'b', name: 'Product B', code: 'B' },
    ]
    const f = await setup({
      recordFilterFields: async () => detailFields,
      productSearch: async () => ({ rows: products, total: 2, pages: 1 }),
    } as Partial<OryhRecordRemote>)
    try {
      await f.bind()
      const context = { key: 'inventory-item-details:list', title: '库存流水', detail: '', scope: '' }
      f.page.sync('inventory-item-details', context)
      await expect(
        f.lists.configureQueryFields('s', ['product_code'], undefined, undefined, new AbortController().signal, [
          'a',
          'a',
        ]),
      ).rejects.toThrow(/选择无效/)
      const configuring = f.lists.configureQueryFields(
        's',
        ['product_code'],
        undefined,
        undefined,
        new AbortController().signal,
        ['a', 'b'],
      )
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload.products).toEqual(products)
      f.page.ack('navigation', 'inventory-item-details', {
        ...context,
        queryFields: ['product_code'],
        productIds: ['a', 'b'],
      })
      expect(await configuring).toContain('查询栏已更新')
    } finally {
      await f.close()
    }
  })
  it('configures the query bar of any list, not only inventory movements', async () => {
    const f = await setup({
      recordFilterFields: async () => [
        { name: 'direction', type: 'string' },
        { name: 'keyword', type: 'string' },
      ],
      recordList: async () => ({ rows: [], page: 1, pages: 1, total: 0, fetchedAt: 'now' }),
    })
    try {
      await f.bind()
      const context = { key: 'shipments:list', title: '收发货', detail: '', scope: '', queryFields: [] as string[] }
      f.page.sync('shipments', context)
      // Product queries exist only for inventory movements.
      await expect(
        f.lists.configureQueryFields('s', ['product_code'], undefined, undefined, new AbortController().signal),
      ).rejects.toThrow(/不支持/)
      const configuring = f.lists.configureQueryFields(
        's',
        ['direction'],
        undefined,
        undefined,
        new AbortController().signal,
      )
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({
        target: 'filters',
        page: 'shipments',
        queryFields: ['direction'],
      })
      f.page.ack('navigation', 'shipments', { ...context, queryFields: ['direction'] })
      expect(await configuring).toContain('查询栏已更新')
    } finally {
      await f.close()
    }
  })
})

describe('menu entries a person adds through chat', () => {
  const inbound = { field: 'direction', value: 'inbound' }
  /** In-memory stand-ins for the Harness storage domain and workspace registry. */
  function harness(f: Awaited<ReturnType<typeof setup>>, cwd = '/ws/a', storage?: { open: unknown }) {
    const rows = new Map<string, unknown>()
    const table = {
      get: (k: string) => rows.get(k),
      put: async (k: string, v: unknown) => {
        rows.set(k, v)
      },
      delete: async (k: string) => rows.delete(k),
    }
    const own = { open: vi.fn(async () => ({ name: 'oryh_user_views', table: () => table, close: async () => {} })) }
    const workspaces = {
      // No recorded memberships: the session's workspace is found by its working directory.
      list: () => [],
      resolveByPath: async (path: string) =>
        path === '/ws/a' ? { id: 'wsA' } : path === '/ws/b' ? { id: 'wsB' } : undefined,
    }
    f.agent.session.header.cwd = cwd
    Object.assign(f.ctx, {
      get: (name: string) =>
        name === 'storageDomain' ? (storage ?? own) : name === 'workspaceRegistry' ? workspaces : undefined,
    })
    return { rows, storage: own }
  }
  const listing = () => ({
    collectionList: vi.fn(async () => ({ rows: [], page: 1, pages: 1, total: 7, fetchedAt: 'now' })),
    collectionRowFields: vi.fn(async () => [
      { name: 'id', type: 'string' as const, required: true },
      { name: 'direction', type: 'string' as const, required: false },
      { name: 'carrier', type: 'string' as const, required: false },
    ]),
  })
  it('reads the list with the filters first, then saves the entry in the session workspace', async () => {
    const records = listing()
    const f = await setup(records)
    try {
      const { rows } = harness(f)
      await f.bind()
      f.page.sync('my-open-todos')
      const receipt = JSON.parse(
        await f.lists.addUserView('s', '入库单', 'shipments', [inbound], [{ field: 'carrier', label: '承运商' }]),
      )
      // The read is the validation: it refuses an undeclared key, and a collection the deployment does
      // not have, before anything is saved.
      expect(records.collectionList).toHaveBeenCalledWith(
        expect.objectContaining({ collection: 'shipments', filters: { direction: 'inbound' } }),
      )
      expect(receipt).toMatchObject({
        added: {
          label: '入库单',
          collection: 'shipments',
          filters: { direction: 'inbound' },
          display: { columns: [{ field: 'carrier', label: '承运商' }] },
        },
        rows: 7,
      })
      const [key, stored] = [...rows.entries()][0]!
      expect(key.startsWith('wsA ')).toBe(true)
      expect((stored as { views: unknown[] }).views).toHaveLength(1)
      // Published to the page by the person's own name.
      expect(f.pane.frame('s').state.userViews).toEqual([receipt.added])
      await expect(f.lists.addUserView('s', '入库单', 'shipments', [inbound])).rejects.toThrow(/已经有/)
    } finally {
      await f.close()
    }
  })
  it('changes nothing when the list refuses the filters', async () => {
    const f = await setup({
      collectionRowFields: vi.fn(async () => [{ name: 'direction', type: 'string' as const, required: false }]),
      collectionList: vi.fn(async () => {
        throw new Error('列表不支持按“directon”筛选。可用字段：direction')
      }),
    })
    try {
      const { rows } = harness(f)
      await f.bind()
      await expect(
        f.lists.addUserView('s', '入库单', 'shipments', [{ field: 'directon', value: 'inbound' }]),
      ).rejects.toThrow(/directon/)
      expect(rows.size).toBe(0)
      // A collection this client never heard of is no longer refused here: the deployment answers.
      await expect(f.lists.addUserView('s', '入库单', 'purchase-requests', [inbound])).rejects.toThrow(/directon|筛选/)
      await expect(f.lists.addUserView('s', '入库单', 'Not A Collection', [inbound])).rejects.toThrow(/集合名称/)
      await expect(f.lists.addUserView('s', '', 'shipments', [inbound])).rejects.toThrow(/1–24/)
    } finally {
      await f.close()
    }
  })
  it('refuses, before saving, a column the built-in list it is drawn by cannot show', async () => {
    const records = {
      collectionList: vi.fn(async () => ({ rows: [], page: 1, pages: 1, total: 2, fetchedAt: 'now' })),
      collectionRowFields: vi.fn(async () =>
        ['id', 'order_no', 'status', 'logistics_tracking_no', 'source_report'].map(name => ({
          name,
          type: 'string' as const,
          required: false,
        })),
      ),
    }
    const f = await setup(records)
    try {
      const { rows } = harness(f)
      await f.bind()
      // The endpoint returns it, but the sales-order list draws its own columns and this is not one.
      await expect(
        f.lists.addUserView('s', '我的订单', 'sales-orders', [], [{ field: 'source_report', label: '来源' }]),
      ).rejects.toThrow(/不能作为它的列[\s\S]*还没有添加/)
      expect(rows.size).toBe(0)
      expect(records.collectionList).not.toHaveBeenCalled()
      const added = JSON.parse(
        await f.lists.addUserView(
          's',
          '我的订单',
          'sales-orders',
          [],
          [
            { field: 'order_no', label: '订单号' },
            { field: 'logistics_tracking_no', label: '物流单号' },
          ],
        ),
      )
      expect(added.added.display.columns.map((c: { field: string }) => c.field)).toEqual([
        'order_no',
        'logistics_tracking_no',
      ])
    } finally {
      await f.close()
    }
  })
  it('keeps a separate menu per workspace', async () => {
    const a = await setup(listing()),
      b = await setup(listing())
    try {
      const stored = harness(a, '/ws/a')
      await a.bind()
      await a.lists.addUserView('s', '入库单', 'shipments', [inbound])
      // Another session in a different workspace, over the same storage, sees none of it.
      harness(b, '/ws/b', stored.storage)
      await b.bind()
      expect(await b.pane.refreshMenu('s')).toEqual([])
    } finally {
      await a.close()
      await b.close()
    }
  })
  it('opens an entry only once the page shows it, and removes one from the workspace', async () => {
    const f = await setup(listing())
    try {
      harness(f)
      await f.bind()
      f.page.sync('my-open-todos')
      const view = JSON.parse(await f.lists.addUserView('s', '入库单', 'shipments', [inbound])).added
      await expect(f.lists.openUserView('s', 'missing', new AbortController().signal)).rejects.toThrow(/没有这个菜单项/)
      const opening = f.lists.openUserView('s', view.id, new AbortController().signal)
      await until(() => f.navigation() !== undefined)
      // The command names the list the entry narrows, so a page sync on that list keeps it alive.
      expect(f.navigation()?.payload).toMatchObject({ target: 'view', userViewId: view.id, page: 'shipments' })
      f.page.ack('navigation', 'shipments', { key: 'shipments:list', title: '入库单', detail: '', scope: '', view })
      expect(JSON.parse(await opening)).toMatchObject({ page: 'shipments', title: '入库单' })
      expect(await f.lists.removeUserView('s', view.id)).toContain('已删除菜单项“入库单”')
      expect(f.pane.frame('s').state.userViews).toEqual([])
      await expect(f.lists.removeUserView('s', view.id)).rejects.toThrow(/没有这个菜单项/)
    } finally {
      await f.close()
    }
  })
})

it('targets the saved view when changing columns and cancels if the user opens another view of the same list', async () => {
  const f = await setup()
  try {
    await f.bind()
    const view = {
      id: 'view-a',
      label: '入库',
      kind: 'inventory-item-details' as const,
      filters: { reason: 'received' },
    }
    const context = {
      key: 'inventory-item-details:list',
      title: '入库',
      detail: '',
      scope: '',
      view,
      columns: ['reason'],
    }
    f.page.sync('inventory-item-details', context)
    const configured = f.lists.configureRecordColumns('s', ['reason', 'product_code'], new AbortController().signal)
    await until(() => f.navigation() !== undefined)
    expect(f.navigation()?.payload.userViewId).toBe('view-a')
    f.page.ack('navigation', 'inventory-item-details', { ...context, columns: ['reason', 'product_code'] })
    expect(await configured).toContain('显示列已更新')

    const stale = f.lists.configureRecordColumns('s', ['reason'], new AbortController().signal)
    const rejected = expect(stale).rejects.toThrow(/页面已变化/)
    await until(() => f.navigation() !== undefined)
    f.page.sync('inventory-item-details', { ...context, view: { ...view, id: 'view-b' } })
    await rejected
    expect(f.navigation()).toBeUndefined()
  } finally {
    await f.close()
  }
})

describe('menu entries colleagues share', () => {
  const inbound = { field: 'direction', value: 'inbound' }
  const records = () => ({
    collectionList: vi.fn(async () => ({ rows: [], page: 1, pages: 1, total: 7, fetchedAt: 'now' })),
    collectionRowFields: vi.fn(async () => [
      { name: 'id', type: 'string' as const, required: true },
      { name: 'direction', type: 'string' as const, required: false },
      { name: 'carrier', type: 'string' as const, required: false },
    ]),
  })
  /** One person's Host: its own menu store, and — on a deployment that keeps one — the enterprise's library. */
  async function host(library?: ReturnType<ReturnType<typeof fakeLibrary>>) {
    const temp = await tempDirectory()
    const harness = fakeContext()
    const rows = new Map<string, unknown>()
    const table = {
      get: (k: string) => rows.get(k),
      put: async (k: string, v: unknown) => {
        rows.set(k, v)
      },
      delete: async (k: string) => rows.delete(k),
    }
    const storage = { open: async () => ({ name: 'oryh_user_views', table: () => table, close: async () => {} }) }
    const workspaces = { list: () => [], resolveByPath: async () => ({ id: 'ws' }) }
    harness.agent.session.header.cwd = '/ws'
    const services: Record<string, unknown> = { storageDomain: storage, workspaceRegistry: workspaces }
    if (library) services.oryhLibrary = library
    Object.assign(harness.ctx, { get: (name: string) => services[name] })
    const pane = new PaneService(
      harness.ctx,
      fakeController().controller,
      temp.directory,
      new UserViewRegistry(harness.ctx),
    )
    const shared = new SharedViews(harness.ctx, pane)
    services.oryhSharedViews = shared
    Object.assign(harness.ctx, { oryhSharedViews: shared })
    shared.install()
    const lists = new ListTools(harness.ctx, pane, records() as unknown as OryhRecordRemote)
    lists.install()
    await pane.bind({ sessionId: 's', connectionId })
    paneSyncer(pane).sync('my-open-todos')
    const exec = { agent: { id: 's' }, signal: new AbortController().signal }
    const state = () => pane.frame('s').state
    return { ...harness, pane, shared, lists, exec, state, close: temp.close }
  }

  it("puts what one person shares in a colleague's menu, by name, without what it showed", async () => {
    const library = fakeLibrary()
    const alice = await host(library('u-alice', '王强')),
      bob = await host(library('u-bob', '李雷'))
    try {
      const mine = JSON.parse(
        await alice.lists.addUserView('s', '入库单', 'shipments', [inbound], [{ field: 'carrier', label: '承运商' }]),
      ).added
      // Read once in the background: nothing is shared yet, and the page is told sharing is on offer.
      await until(() => bob.state().sharedViews !== undefined)
      expect(bob.state().sharedViews).toEqual([])

      const said = await alice.tool('oryh_menu_share').execute({ userViewId: mine.id, shared: true }, alice.exec)
      expect(said).toContain('没有共享任何数据')
      await until(() => bob.state().sharedViews?.length === 1)
      expect(bob.state().sharedViews).toEqual([
        {
          id: mine.id,
          label: '入库单',
          origin: 'shared',
          sharedBy: '王强',
          collection: 'shipments',
          filters: { direction: 'inbound' },
          display: { columns: [{ field: 'carrier', label: '承运商' }] },
        },
      ])
      // Its author sees it as their own, marked as shared, and not a second time among colleagues'.
      await until(() => alice.state().sharedOwn?.length === 1)
      expect(alice.state().sharedViews).toEqual([])
      expect(alice.state().sharedOwn).toEqual([mine.id])
      // The agent is told which is whose.
      expect(currentPage(bob.pane, 's').userMenu).toEqual([expect.objectContaining({ id: mine.id, sharedBy: '王强' })])
      // A colleague cannot change the sharing, or remove what is not theirs.
      await expect(
        bob.tool('oryh_menu_share').execute({ userViewId: mine.id, shared: false }, bob.exec),
      ).rejects.toThrow('只有共享的人可以更改共享')
      await expect(bob.tool('oryh_menu_remove').execute({ userViewId: mine.id }, bob.exec)).rejects.toThrow(
        '同事共享的',
      )
    } finally {
      await alice.close()
      await bob.close()
    }
  })

  it('gives a colleague a copy of their own to change, and withdraws the original without touching the copy', async () => {
    const library = fakeLibrary()
    const alice = await host(library('u-alice', '王强')),
      bob = await host(library('u-bob', '李雷'))
    try {
      const mine = JSON.parse(await alice.lists.addUserView('s', '入库单', 'shipments', [inbound])).added
      await alice.shared.share('s', mine.id, true)
      await until(() => bob.state().sharedViews?.length === 1)

      const copied = JSON.parse(await bob.tool('oryh_menu_copy').execute({ sharedViewId: mine.id }, bob.exec))
      expect(copied).toMatchObject({ copied: true, label: '入库单' })
      expect(copied.userViewId).not.toBe(mine.id)
      expect(bob.state().userViews).toEqual([
        expect.objectContaining({ id: copied.userViewId, label: '入库单', collection: 'shipments' }),
      ])
      expect(bob.state().userViews![0]).not.toHaveProperty('origin')
      // A second copy would clash with the first by name: it says whose it was.
      expect((await bob.shared.copy('s', mine.id)).label).toBe('入库单（王强）')

      // Removing the entry withdraws what was shared of it; the copies stay.
      const removed = await alice.tool('oryh_menu_remove').execute({ userViewId: mine.id }, alice.exec)
      expect(removed).toContain('同时取消了对同事的共享')
      await until(() => bob.state().sharedViews?.length === 0)
      expect(bob.state().userViews).toHaveLength(2)
      await expect(bob.shared.copy('s', mine.id)).rejects.toThrow('已经不在了')
    } finally {
      await alice.close()
      await bob.close()
    }
  })

  it('retains the local menu after withdrawal fails and retries against the library without a warm cache', async () => {
    const library = fakeLibrary()
    const api = library('u-alice', '王强')
    const alice = await host(api)
    try {
      const mine = JSON.parse(await alice.lists.addUserView('s', '入库单', 'shipments', [inbound])).added
      await alice.shared.share('s', mine.id, true)
      vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('library unavailable'))
      await expect(alice.lists.removeUserView('s', mine.id)).rejects.toThrow('共享库暂时不可用')
      expect(alice.state().userViews?.some(v => v.id === mine.id)).toBe(true)
      const remove = vi.spyOn(api, 'remove').mockRejectedValueOnce(new Error('library unavailable'))
      await expect(alice.lists.removeUserView('s', mine.id)).rejects.toThrow('共享库暂时不可用')
      expect(alice.state().userViews?.some(v => v.id === mine.id)).toBe(true)
      expect(await api.get('menu', mine.id)).toBeDefined()
      // A new service has no menu cache; it must still see and withdraw this person's shared entry.
      const cold = new SharedViews(alice.ctx, alice.pane)
      expect(await cold.forget(mine.id, 'menu')).toBe(true)
      expect(remove).toHaveBeenCalledTimes(2)
      expect(await api.get('menu', mine.id)).toBeUndefined()
      expect(await alice.lists.removeUserView('s', mine.id)).toContain('已删除菜单项')
      expect(alice.state().userViews ?? []).toEqual([])
    } finally {
      await alice.close()
    }
  })

  it('leaves out an entry it cannot read, and offers nothing where the deployment keeps no library', async () => {
    const library = fakeLibrary()
    const alice = library('u-alice', '王强')
    await alice.put({ kind: 'menu', id: '00000000-0000-4000-8000-000000000001', title: '坏的', body: { filters: 7 } })
    await alice.put({
      kind: 'menu',
      id: '00000000-0000-4000-8000-000000000002',
      title: '好的',
      body: { collection: 'shipments', filters: {} },
    })
    const bob = await host(library('u-bob', '李雷')),
      alone = await host()
    try {
      await until(() => bob.state().sharedViews !== undefined)
      expect(bob.state().sharedViews!.map(view => view.label)).toEqual(['好的'])
      // The desktop: no library, so the page is told nothing about sharing and the tool says why.
      expect(alone.state()).not.toHaveProperty('sharedViews')
      const own = JSON.parse(await alone.lists.addUserView('s', '入库单', 'shipments', [inbound])).added
      await expect(
        alone.tool('oryh_menu_share').execute({ userViewId: own.id, shared: true }, alone.exec),
      ).rejects.toThrow('没有共享库')
    } finally {
      await bob.close()
      await alone.close()
    }
  })
})

describe('the menu a role implies', () => {
  const invoices = {
    collection: 'invoices',
    filters: { direction: 'payroll' },
    label: '发票·工资条',
    display: { columns: [{ field: 'invoice_no', label: '发票号' }], title: 'invoice_no' },
  }
  const shipments = {
    collection: 'shipments',
    filters: {},
    label: '收发货',
    display: { columns: [{ field: 'shipment_no', label: '单号' }] },
  }

  it('publishes what the role adds beside the pages, and nothing a page already shows', async () => {
    const roleViews = vi.fn(async () => [invoices, shipments])
    const f = await setup({ roleViews })
    try {
      await f.bind()
      f.pane.contribute({ name: 'shipments-page', resources: { shipments: 'shipments' } })
      f.page.sync('my-open-todos')
      // Read in the background on the first frame, then published by another frame.
      expect(f.pane.frame('s').state.roleViews).toBeUndefined()
      await until(() => f.pane.frame('s').state.roleViews !== undefined)
      const [entry, ...rest] = f.pane.frame('s').state.roleViews!
      expect(rest).toEqual([])
      expect(entry).toMatchObject({ label: '发票·工资条', collection: 'invoices', filters: { direction: 'payroll' } })
      // Shaped like a menu entry's id, and the same every time, so the page routes and restores it.
      expect(entry!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(f.lists.roleViews('s')![0]!.id).toBe(entry!.id)
      expect(roleViews).toHaveBeenCalledTimes(1)
      // It is the role, not the person's to delete.
      await expect(f.lists.removeUserView('s', entry!.id)).rejects.toThrow('来自你在 ORYH 的权限')
    } finally {
      await f.close()
    }
  })

  it('gives a workbench with no session open the role menu, read once for the identity', async () => {
    const roleViews = vi.fn(async () => [invoices])
    const f = await setup({ roleViews })
    try {
      // A person who has not opened Chat yet: no session is bound, and the menu still comes.
      const [entry, ...rest] = await f.pane.connectionMenu(connectionId)
      expect(rest).toEqual([])
      expect(entry).toMatchObject({ label: '发票·工资条', origin: 'role', filters: { direction: 'payroll' } })
      // The session opened afterwards for the same identity shows the same entry without reading again.
      await f.bind()
      f.page.sync('my-open-todos')
      expect(f.pane.frame('s').state.roleViews?.[0]?.id).toBe(entry!.id)
      expect(roleViews).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  })

  it('reads a role menu it cannot build as empty, and keeps serving the pane', async () => {
    const f = await setup({
      roleViews: vi.fn(async () => {
        throw new Error('catalogue unreachable')
      }),
    })
    try {
      await f.bind()
      f.page.sync('my-open-todos')
      f.pane.frame('s')
      await until(() => f.pane.frame('s').state.roleViews !== undefined)
      expect(f.pane.frame('s').state.roleViews).toEqual([])
    } finally {
      await f.close()
    }
  })
})
