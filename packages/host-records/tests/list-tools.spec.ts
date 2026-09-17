import type { OryhRecordRemote } from '@oryh/ai-client-records'
import { PaneService, UserViewRegistry } from '@oryh/dsh-pane'
import {
  connectionId,
  fakeContext,
  fakeController,
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
        f.page.sync('timesheets')
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
    recordList: vi.fn(async () => ({ rows: [], page: 1, pages: 1, total: 7, fetchedAt: 'now' })),
  })
  it('reads the list with the filters first, then saves the entry in the session workspace', async () => {
    const records = listing()
    const f = await setup(records)
    try {
      const { rows } = harness(f)
      await f.bind()
      f.page.sync('my-open-todos')
      const receipt = JSON.parse(await f.lists.addUserView('s', '入库单', 'shipments', [inbound]))
      // The read is the validation: the records service refuses an undeclared key before anything is saved.
      expect(records.recordList).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'shipments', filters: { direction: 'inbound' } }),
      )
      expect(receipt).toMatchObject({
        added: { label: '入库单', kind: 'shipments', filters: { direction: 'inbound' } },
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
      recordList: vi.fn(async () => {
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
      await expect(f.lists.addUserView('s', '入库单', 'purchase-requests', [inbound])).rejects.toThrow(/已有列表/)
      await expect(f.lists.addUserView('s', '', 'shipments', [inbound])).rejects.toThrow(/1–24/)
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
