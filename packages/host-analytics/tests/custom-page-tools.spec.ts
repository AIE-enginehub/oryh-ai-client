import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { RecordService } from '@oryh/ai-client-records'
import { connectionId, fakeConnection, fakeContext } from '@oryh/dsh-pane/testing'
import { describe, expect, it, vi } from 'vitest'
import type { CustomPageService } from '../src/custom-service.js'
import * as plugin from '../src/index.js'

const definition = {
  title: '订单统计',
  html: '<main><span data-oryh-field="total"></span></main>',
  css: '',
  script: '',
  fixedText: '',
  task: {
    instruction: '统计当前销售订单并说明风险，不得编造事实。',
    timeZone: 'Asia/Shanghai',
    sources: [{ collection: 'sales-orders', filters: {}, display: { columns: [{ field: 'id', label: '编号' }] } }],
    contract: { fields: [{ name: 'total', type: 'number', required: true }] },
  },
}
/** The same page with a changed task, as CP-16's edit left it: its result has to be read again. */
const otherTask = {
  ...definition,
  task: { ...definition.task, instruction: '统计当前销售订单和库存流水并说明风险，不得编造事实。' },
}

/**
 * The analytics plugin over a fake Host: pages in a storage domain held in memory, a browser that opens the
 * page it is sent to and reports the version it shows, and a data run whose outcome the test sets.
 */
function setup() {
  const harness = fakeContext()
  const connection = fakeConnection()
  const session = { connectionId, scope: 'owner-a', context: undefined as { key: string; content: string } | undefined }
  const menu: { id: string; label: string; collection: string; filters: Record<string, string> }[] = []
  const tables = new Map<string, unknown>()
  let service!: CustomPageService
  const pane = {
    provideState: vi.fn(),
    contribute: vi.fn((_contribution: { prompt?: readonly string[] }) => () => {}),
    home: () => session,
    session: () => session,
    verified: async () => ({ connection, session }),
    userViews: {
      workspace: async () => 'workspace',
      list: async () => menu,
      add: async (_session: string, _scope: string, view: (typeof menu)[number]) => {
        menu.push(view)
        return menu
      },
    },
    menu: () => menu,
    // Everything the session can open: here, only the person's own.
    entries: () => menu,
    setMenu: vi.fn(),
    refreshMenu: vi.fn(),
    changed: vi.fn(),
    acked: () => true,
    issue: async (
      sessionId: string,
      spec: { payload: { userViewId: string } },
      receipt: (id: string) => { until: () => string | undefined; expired: string },
    ) => {
      const wait = receipt('command')
      const shown = await service.load({ sessionId, connectionId, id: spec.payload.userViewId })
      session.context = { key: `custom:${shown.id}`, content: JSON.stringify({ version: shown.version }) }
      const answer = wait.until()
      if (answer === undefined) throw new Error(wait.expired)
      return answer
    },
  }
  // The plugin builds its record service on what the Host offers a domain to read with; these tests are
  // not about that service, so what it answers is set here.
  vi.spyOn(RecordService, 'over').mockReturnValue({
    collectionFilterFields: vi.fn(async () => []),
    collectionRowFields: vi.fn(async () => [{ name: 'id', type: 'string', required: true }]),
    collectionList: vi.fn(async () => ({ rows: [], total: 0, pages: 1, page: 1, fetchedAt: '' })),
  } as never)
  Object.assign(harness.ctx, {
    oryhHost: {
      createDomainReads: () => ({}),
      createPageReader: () => ({ read: vi.fn(async () => ({ data: [] })) }),
    },
    oryhPane: pane,
    // The runner is registered as a subagent provider; these tests stub the run itself.
    subagents: { registerProvider: vi.fn() },
    storageDomain: {
      open: async () => ({
        table: () => ({
          get: (key: string) => tables.get(key),
          put: async (key: string, value: unknown) => {
            tables.set(key, value)
          },
        }),
        close: () => {},
      }),
    },
    // The pane's sharing service, as far as this plugin registers with it; sharing has tests of its own.
    oryhSharedViews: { providePages: () => () => {} },
  })
  plugin.apply(harness.ctx as Context)
  service = (harness.ctx as unknown as { oryhCustomPages: CustomPageService }).oryhCustomPages
  /** A tool call from the Chat session, and its JSON answer. */
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(await harness.tool(name).execute(args, { agent: { id: 's' }, signal: new AbortController().signal }))
  /** What the page's data run does next: publish a total, or end without one and say why. */
  const runner = (outcome: { total: number } | string) => {
    ;(service as unknown as { execute: (active: { result?: object; lastWords?: string }) => Promise<void> }).execute =
      async active => {
        if (typeof outcome === 'string') active.lastWords = outcome
        else active.result = outcome
      }
  }
  return { call, runner, connection, pane }
}

it('tells the agent a page form still needs confirmation in the conversation', () => {
  const f = setup()
  const prompts = f.pane.contribute.mock.calls.flatMap(([contribution]) => contribution.prompt ?? [])
  const words = prompts.join('\n')
  expect(words).toContain('还没有在对话中确认业务写入')
  expect(words).toContain('等用户明确确认后再按其中的任务执行')
  expect(words).not.toContain('用户已在页面确认')
})

describe('the two ways of writing a page (docs/53)', () => {
  it('offers both, with the rule for choosing, and saves a page written with Harness components', async () => {
    const f = setup()
    const catalog = await f.call('oryh_custom_page_catalog', {})
    expect(catalog.modes).toContain('用户说"用 Harness 组件"')
    expect(catalog.modes).toContain('就用 html')
    expect(catalog.blocks).toContain('table {data, columns')
    expect(catalog.harnessExample.mode).toBe('harness')
    const harness = {
      title: definition.title,
      mode: 'harness',
      blocks: [{ type: 'metrics', items: [{ label: '合计', field: 'total', format: 'number' }] }, { type: 'fixed' }],
      task: definition.task,
    }
    const saved = await f.call('oryh_custom_page_save', { definitionJson: JSON.stringify(harness) })
    expect(saved).toMatchObject({ saved: true, version: 1 })
    const page = await f.call('oryh_custom_page_get', { id: saved.id })
    expect(page.definition).toMatchObject({ mode: 'harness', blocks: harness.blocks, script: '', fixedText: '' })
    expect(page.definition.html).toBeUndefined()
    // A binding the contract does not have is refused, naming the block.
    await expect(
      f.call('oryh_custom_page_save', {
        definitionJson: JSON.stringify({
          ...harness,
          blocks: [{ type: 'metrics', items: [{ label: '笔数', field: 'count' }] }],
        }),
      }),
    ).rejects.toThrow('blocks[0]（metrics）：count 不在数据约定里')
  })
})

describe('what the custom page tools tell the agent the page shows', () => {
  it('says a failed refresh of a changed task leaves no data on show, and that an undo shows the last result again', async () => {
    const f = setup()
    const saved = await f.call('oryh_custom_page_save', { definitionJson: JSON.stringify(definition) })
    f.runner({ total: 2 })
    const first = await f.call('oryh_custom_page_run', { id: saved.id, expectedVersion: 1 })
    expect(first).toMatchObject({ displayed: true, version: 1, result: { version: 1 } })
    // CP-16: version 2 changes the task, and its refresh fails on a source over 1000 rows.
    const changed = await f.call('oryh_custom_page_save', {
      id: saved.id,
      expectedVersion: 1,
      definitionJson: JSON.stringify(otherTask),
    })
    expect(changed).toMatchObject({ version: 2, needsRefresh: true })
    f.runner('/inventory-movements 有 1001 条，超过每个数据集 1000 条的上限，请加筛选条件。')
    const failed = await f.call('oryh_custom_page_run', { id: saved.id, expectedVersion: 2 })
    expect(failed).toMatchObject({ refreshed: false, id: saved.id, version: 2, displayed: false, result: null })
    expect(failed.error).toContain('1001 条')
    // The agent said the page still showed version 1's result; it is another task's, and the page shows nothing.
    expect(failed.message).toContain('页面上不显示任何数据')
    expect(failed.message).toContain('最近的成功结果属于第 1 版')
    expect(failed.message).toContain('oryh_custom_page_restore')
    // Opening it says the same: the page is on screen, with no data for its version.
    const opened = await f.call('oryh_custom_page_open', { id: saved.id })
    expect(opened).toMatchObject({ displayed: true, version: 2, result: null })
    expect(opened.message).toContain('页面上不显示任何数据')
    // The undo is version 1's task again: its result is version 3's at once, without a refresh (R2-4).
    const undone = await f.call('oryh_custom_page_restore', { id: saved.id, expectedVersion: 2 })
    expect(undone).toMatchObject({ restored: true, version: 3, needsRefresh: false })
    expect(await f.call('oryh_custom_page_open', { id: saved.id })).toEqual({
      saved: true,
      id: saved.id,
      displayed: true,
      version: 3,
      result: { version: 3, at: first.result.at },
    })
    // A refresh of a version that has a result, failing, leaves that result on show, and says so.
    f.runner('模型连接失败。')
    const kept = await f.call('oryh_custom_page_run', { id: saved.id, expectedVersion: 3 })
    expect(kept).toMatchObject({ refreshed: false, version: 3, result: { version: 3, at: first.result.at } })
    expect(kept.message).toContain('页面继续显示上次成功的结果')
  })
  it('says a result hidden since grants changed is not on show, and fails as before when the page cannot be read', async () => {
    const f = setup()
    const saved = await f.call('oryh_custom_page_save', { definitionJson: JSON.stringify(definition) })
    f.runner({ total: 2 })
    await f.call('oryh_custom_page_run', { id: saved.id, expectedVersion: 1 })
    f.connection.identity.permissions.push('invoice.manage:payroll')
    f.runner('模型连接失败。')
    const failed = await f.call('oryh_custom_page_run', { id: saved.id, expectedVersion: 1 })
    expect(failed).toMatchObject({ refreshed: false, displayed: false, result: null })
    expect(failed.message).toContain('权限')
    await expect(f.call('oryh_custom_page_run', { id: randomUUID(), expectedVersion: 1 })).rejects.toThrow(
      '自定义页面不存在',
    )
  })
})
