/** A custom page shared with colleagues (docs/58): two people, each with their own pages, and one library. */
import type { Context } from '@deepseek-ai/cordis'
import type { OryhRecordRemote } from '@oryh/ai-client-records'
import { type PaneService, SharedViews } from '@oryh/dsh-pane'
import { fakeConnection, fakeLibrary, until } from '@oryh/dsh-pane/testing'
import { expect, it, vi } from 'vitest'
import { type CustomPage, customDefinitionSchema } from '../src/custom-model.js'
import { CustomPageService } from '../src/custom-service.js'

const definition = customDefinitionSchema.parse({
  title: '订单统计',
  html: '<main id="app"><span data-oryh-field="total"></span></main>',
  css: '',
  script: '',
  fixedText: '',
  task: {
    instruction: '统计当前销售订单并说明风险，不得编造事实。',
    timeZone: 'Asia/Shanghai',
    sources: [{ collection: 'sales-orders', filters: {}, display: { columns: [{ field: 'id', label: '编号' }] } }],
    contract: { fields: [{ name: 'total', type: 'number', required: true }] },
  },
})

/** One person's Host, as far as custom pages and sharing go. */
function person(library: ReturnType<ReturnType<typeof fakeLibrary>>) {
  const connection = fakeConnection(),
    session = { scope: 'me', connectionId: 'c' }
  const db = new Map<string, CustomPage[]>()
  const menu: { id: string; label: string; collection: string; filters: Record<string, string> }[] = []
  const services: Record<string, unknown> = { oryhLibrary: library }
  const ctx = { effect: vi.fn(), on: vi.fn(), get: (name: string) => services[name] } as unknown as Context
  const pane = {
    verified: async () => ({ connection, session }),
    session: () => session,
    home: () => session,
    userViews: {
      workspace: async () => 'workspace',
      list: async () => menu,
      add: async (_s: string, _i: string, item: (typeof menu)[number]) => {
        menu.push(item)
        return menu
      },
      rename: async () => {},
      remove: async (_s: string, _i: string, id: string) => {
        const index = menu.findIndex(m => m.id === id)
        if (index >= 0) menu.splice(index, 1)
      },
    },
    menu: () => menu,
    setMenu: vi.fn(),
    refreshMenu: vi.fn(async () => menu),
    changed: vi.fn(),
    changedEverywhere: vi.fn(),
    serverChanged: vi.fn(),
    provideState: () => () => {},
    provideMenu: () => () => {},
  } as unknown as PaneService
  const records = {
    collectionFilterFields: vi.fn(async () => []),
    collectionRowFields: vi.fn(async () => [{ name: 'id', type: 'string', required: true }]),
    collectionList: vi.fn(async () => ({ rows: [], total: 0, pages: 1, page: 1, fetchedAt: '' })),
  } as unknown as OryhRecordRemote
  const storage = {
    read: async (key: string) => structuredClone(db.get(key) ?? []),
    write: async (key: string, value: CustomPage[]) => {
      db.set(key, structuredClone(value))
    },
  }
  const service = new CustomPageService(ctx, pane, records, storage)
  // The pane's sharing service with a context of its own: installed, it follows what colleagues change.
  const sharing = {
    get: (name: string) => services[name],
    effect: (fn: () => unknown) => fn(),
    inject: (_names: string[], fn: (inner: unknown) => unknown) => fn(sharing),
  }
  const shared = new SharedViews(sharing as unknown as Context, pane)
  services.oryhSharedViews = shared
  shared.install()
  shared.providePages({
    definition: (sessionId, id) => service.sharedMake(sessionId, id),
    copy: (sessionId, entry) => service.copyShared(sessionId, entry),
  })
  const request = { sessionId: 's', connectionId: 'c' as never }
  const stored = () => [...db.values()].flat()
  return { service, shared, request, stored, menu }
}

it("puts a shared page in a colleague's menu, and gives them a copy of how it is made with no result", async () => {
  const library = fakeLibrary()
  const alice = person(library('u-alice', '王强')),
    bob = person(library('u-bob', '李雷'))
  const page = await alice.service.save({ ...alice.request, definition })
  expect(await alice.shared.share('s', page.id, true)).toContain('没有共享任何数据')
  // Its author sees it as their own, marked shared, not among colleagues'.
  await until(() => alice.shared.own().length === 1)
  expect(alice.shared.views()).toEqual([])

  await until(() => bob.shared.views().length === 1)
  expect(bob.shared.views()).toEqual([
    { id: page.id, label: '订单统计', origin: 'shared', sharedBy: '王强', collection: 'custom-pages', filters: {} },
  ])
  // Nothing of it is on the colleague's disk until they open it.
  expect(bob.stored()).toEqual([])
  const opened = await bob.service.load({ ...bob.request, id: page.id })
  expect(opened).toMatchObject({
    id: page.id,
    sharedFrom: { author: '王强' },
    definition: { title: '订单统计' },
  })
  expect(opened.latest).toBeUndefined()
  // It is not one of their own pages, and not theirs to change.
  expect(await bob.service.listSummaries(bob.request)).toEqual([])
  expect(await bob.service.list(bob.request)).toEqual([])
  await expect(
    bob.service.save({ ...bob.request, id: page.id, expectedVersion: opened.version, definition }),
  ).rejects.toThrow('王强共享的页面，不能直接修改')
  await expect(bob.shared.share('s', page.id, false)).rejects.toThrow('只有共享的人可以更改共享')
  // Nor theirs to delete: the copy would only come back the next time it is opened.
  await expect(bob.service.delete({ ...bob.request, id: page.id, expectedVersion: opened.version })).rejects.toThrow(
    '王强共享的页面，不能删除',
  )
  expect(bob.stored()).toHaveLength(1)
})

it("follows the author's changes, and goes when the author withdraws or deletes the page", async () => {
  const library = fakeLibrary()
  const alice = person(library('u-alice', '王强')),
    bob = person(library('u-bob', '李雷'))
  const page = await alice.service.save({ ...alice.request, definition })
  await alice.shared.share('s', page.id, true)
  await until(() => bob.shared.views().length === 1)
  const first = await bob.service.load({ ...bob.request, id: page.id })

  // The author edits the page: saving says it again to the library, and the colleague's copy follows.
  await until(() => alice.shared.own().length === 1)
  const edited = await alice.service.save({
    ...alice.request,
    id: page.id,
    expectedVersion: page.version,
    definition: { ...definition, fixedText: '按周统计' },
  })
  const second = await bob.service.load({ ...bob.request, id: page.id })
  expect(second.definition.fixedText).toBe('按周统计')
  expect(first.sharedFrom?.changed).toBeUndefined()
  expect(second.sharedFrom).toMatchObject({ author: '王强', changed: true })
  expect(second.version).toBeGreaterThan(first.version)
  // Opened again with nothing changed, it is left as it is.
  expect((await bob.service.load({ ...bob.request, id: page.id })).version).toBe(second.version)
  // Running the updated page is how the viewer acknowledges it: the notice goes with the refreshed copy.
  ;(bob.service as unknown as { execute: (active: { result?: object }) => Promise<void> }).execute = async active => {
    active.result = { total: 1 }
  }
  const refreshed = await bob.service.run({ ...bob.request, id: page.id, expectedVersion: second.version })
  expect(refreshed.sharedFrom).toMatchObject({ author: '王强' })
  expect(refreshed.sharedFrom?.changed).toBeUndefined()

  // Deleting the page withdraws it: it leaves the colleague's menu, and their copy goes when next opened.
  await alice.service.delete({ ...alice.request, id: page.id, expectedVersion: edited.version })
  await until(() => bob.shared.views().length === 0)
  await expect(bob.service.load({ ...bob.request, id: page.id })).rejects.toThrow('自定义页面不存在')
  expect(bob.stored()).toEqual([])
})

it('makes a page of their own for a colleague who copies one, theirs to change', async () => {
  const library = fakeLibrary()
  const alice = person(library('u-alice', '王强')),
    bob = person(library('u-bob', '李雷'))
  const page = await alice.service.save({ ...alice.request, definition })
  await alice.shared.share('s', page.id, true)
  await until(() => bob.shared.views().length === 1)

  const copy = await bob.shared.copy('s', page.id)
  expect(copy).toMatchObject({ kind: 'page', label: '订单统计' })
  expect(copy.id).not.toBe(page.id)
  const own = await bob.service.load({ ...bob.request, id: copy.id })
  expect(own.sharedFrom).toBeUndefined()
  expect((await bob.service.listSummaries(bob.request)).map(p => p.title)).toEqual(['订单统计'])
  // Theirs to change, and a second copy says whose it was rather than clash by name.
  await bob.service.save({
    ...bob.request,
    id: copy.id,
    expectedVersion: own.version,
    definition: { ...own.definition, fixedText: '我的口径' },
  })
  expect((await bob.shared.copy('s', page.id)).label).toBe('订单统计（王强）')
  // Withdrawn by its author, the copies stay.
  expect(await alice.shared.share('s', page.id, false)).toContain('已取消共享')
  await until(() => bob.shared.views().length === 0)
  expect(await bob.service.listSummaries(bob.request)).toHaveLength(2)
  await expect(bob.shared.copy('s', page.id)).rejects.toThrow('已经不在了')
})

it("opens and copies a colleague's page before the menu has heard of it, as a page restored after a reload does", async () => {
  const library = fakeLibrary()
  const alice = person(library('u-alice', '王强'))
  const page = await alice.service.save({ ...alice.request, definition })
  await alice.shared.share('s', page.id, true)
  // A Host that has just started: nothing has asked for the menu yet.
  const bob = person(library('u-bob', '李雷'))
  expect(await bob.service.load({ ...bob.request, id: page.id })).toMatchObject({ sharedFrom: { author: '王强' } })
  const carol = person(library('u-carol', '韩梅'))
  expect(await carol.shared.copy('s', page.id)).toMatchObject({ kind: 'page', label: '订单统计' })
})

it('preserves the page and its menu until shared withdrawal succeeds', async () => {
  const api = fakeLibrary()('u-alice', '王强')
  const alice = person(api)
  const page = await alice.service.save({ ...alice.request, definition })
  alice.menu.push({ id: page.id, label: page.definition.title, collection: 'custom-pages', filters: {} })
  await alice.shared.share('s', page.id, true)
  const remove = vi.spyOn(api, 'remove').mockRejectedValueOnce(new Error('library unavailable'))
  const request = { ...alice.request, id: page.id, expectedVersion: page.version }
  await expect(alice.service.delete(request)).rejects.toThrow('共享库暂时不可用')
  expect(alice.stored().some(p => p.id === page.id)).toBe(true)
  expect(alice.menu.some(p => p.id === page.id)).toBe(true)
  expect(await api.get('page', page.id)).toBeDefined()
  await alice.service.delete(request)
  expect(remove).toHaveBeenCalledTimes(2)
  expect(alice.stored()).toEqual([])
  expect(alice.menu).toEqual([])
  expect(await api.get('page', page.id)).toBeUndefined()
})
