import type { BusinessRecord, OryhRecordRemote } from '@oryh/ai-client-records'
import type { PaneService } from '@oryh/dsh-pane'
import { fakeConnection } from '@oryh/dsh-pane/testing'
import { describe, expect, it, vi } from 'vitest'
import {
  type AnalysisDocument,
  aggregate,
  changeSection,
  defaultDefinition,
  definitionSchema,
  groupId,
  patchDefinition,
  validateDefinition,
} from '../src/model.js'
import { AnalysisService } from '../src/service.js'

const row = (id: string, field: string, value: string, group = 'CNY'): BusinessRecord => ({
  id,
  title: id,
  status: '',
  summary: '',
  date: '',
  fields: [
    { label: '币种', value: group },
    { label: '仓库', value: group },
    { label: field, value },
  ],
})
function fixture() {
  const connection = fakeConnection(),
    session = {
      connectionId: 'c',
      scope: 'owner-a',
      context: undefined as { key: string; detail: string; content: string } | undefined,
    }
  const db = new Map<string, AnalysisDocument[]>(),
    records = {
      recordList: vi.fn(async () => ({
        page: 1,
        pages: 1,
        total: 2,
        fetchedAt: '',
        rows: [row('a', '订单总额', '0.1'), row('b', '订单总额', '0.2')],
      })),
    }
  const pane = {
    verified: async () => ({ connection, session }),
    home: () => session,
    userViews: { workspace: async () => 'workspace' },
  } as unknown as PaneService
  const storage = {
    read: async (key: string) => structuredClone(db.get(key) ?? []),
    write: async (key: string, docs: AnalysisDocument[]) => {
      db.set(key, structuredClone(docs))
    },
  }
  const service = new AnalysisService(pane, records as unknown as OryhRecordRemote, storage)
  const request = { sessionId: 's', connectionId: 'c' },
    definition = defaultDefinition()
  return { connection, session, db, records, service, storage, pane, request, definition }
}
describe('analysis correctness and ownership', () => {
  it('uses exact decimal sums, separates currencies, and refuses unsafe mixed measures or missing numeric values', () => {
    const d = { ...defaultDefinition(), source: 'sales-orders' as const, groupBy: 'currency', measure: 'total_amount' }
    expect(
      aggregate(d, [row('a', '订单总额', '0.1'), row('b', '订单总额', '0.2'), row('c', '订单总额', '-2', 'USD')]).map(
        g => g.value,
      ),
    ).toEqual(['0.3', '-2'])
    expect(() => validateDefinition({ ...d, groupBy: 'status' })).toThrow('币种')
    expect(() => aggregate(d, [row('a', '订单总额', '—')])).toThrow('数值')
    expect(() =>
      validateDefinition({ ...defaultDefinition(), measure: 'quantity_on_hand', groupBy: 'facility' }),
    ).toThrow('产品')
  })
  it('walks every page and refuses truncated, duplicate, changing or oversized results', async () => {
    const f = fixture(),
      r = { ...f.request, definition: f.definition }
    f.records.recordList.mockImplementation(async (q?: unknown) => {
      const p = (q as { page: number }).page
      return { page: p, pages: 2, total: 2, fetchedAt: '', rows: [row(String(p), '', '')] }
    })
    expect((await f.service.preview(r)).total).toBe(2)
    expect(f.records.recordList).toHaveBeenCalledTimes(2)
    f.records.recordList.mockResolvedValue({ page: 1, pages: 2, total: 2, fetchedAt: '', rows: [row('a', '', '')] })
    await expect(f.service.preview(r)).rejects.toThrow('重复')
    f.records.recordList.mockResolvedValue({ page: 1, pages: 1, total: 2, fetchedAt: '', rows: [] })
    await expect(f.service.preview(r)).rejects.toThrow('完整')
    f.records.recordList.mockResolvedValue({ page: 1, pages: 1, total: 1001, fetchedAt: '', rows: [] })
    await expect(f.service.preview(r)).rejects.toThrow('上限')
    f.records.recordList
      .mockResolvedValueOnce({ page: 1, pages: 2, total: 2, fetchedAt: '', rows: [row('a', '', '')] })
      .mockResolvedValueOnce({ page: 2, pages: 2, total: 3, fetchedAt: '', rows: [row('b', '', '')] })
    await expect(f.service.preview(r)).rejects.toThrow('总量改变')
  })
  it('persists only definitions, reloads fresh rows, and protects optimistic revisions even for parallel saves', async () => {
    const f = fixture(),
      created = await f.service.save({ ...f.request, definition: f.definition })
    expect(JSON.stringify([...f.db.values()])).not.toContain('rowIds')
    const restored = new AnalysisService(f.pane, f.records as unknown as OryhRecordRemote, f.storage)
    expect((await restored.load({ ...f.request, id: created.document.id })).document).toEqual(created.document)
    const writes = await Promise.allSettled(
      [1, 2].map(n =>
        restored.save({
          ...f.request,
          id: created.document.id,
          expectedVersion: 1,
          definition: { ...f.definition, title: `revision ${n}` },
        }),
      ),
    )
    expect(writes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(writes.filter(r => r.status === 'rejected')).toHaveLength(1)
  })
  it('denies another enterprise, isolates an owner scope, and leaves a revoked permission to ORYH', async () => {
    const f = fixture(),
      created = await f.service.save({ ...f.request, definition: f.definition })
    await expect(f.service.list({ ...f.request, connectionId: 'other' })).rejects.toThrow('不一致')
    f.session.scope = 'owner-b'
    expect(await f.service.list(f.request)).toEqual([])
    await expect(f.service.load({ ...f.request, id: created.document.id })).rejects.toThrow('不存在')
    f.session.scope = 'owner-a'
    // A grant taken away in ORYH: the document is still the person's own, and this client refuses nothing
    // by a rule of its own. Reading its source asks ORYH as them, and ORYH's refusal is what they are told.
    f.connection.identity.permissions = ['order.submit_own']
    expect((await f.service.list(f.request)).map(d => d.id)).toEqual([created.document.id])
    await expect(f.service.load({ ...f.request, id: created.document.id })).resolves.toBeDefined()
    const refusal = new Error('ORYH 没有允许当前账号读取或办理这项内容（HTTP 403）。权限由 ORYH 的管理员设置。')
    f.records.recordList.mockRejectedValue(refusal)
    await expect(f.service.preview({ ...f.request, definition: f.definition })).rejects.toBe(refusal)
  })
  it('does not overwrite hand edits with a model definition and rejects a scope switch during the query', async () => {
    const f = fixture(),
      created = await f.service.save({ ...f.request, definition: f.definition })
    f.session.context = {
      key: `analytics:${created.document.id}`,
      detail: 'Unsaved changes',
      content: JSON.stringify({ dirty: true, definition: patchDefinition(f.definition, { summary: 'manual text' }) }),
    }
    await expect(
      f.service.save({
        ...f.request,
        id: created.document.id,
        expectedVersion: 1,
        definition: patchDefinition(f.definition, { summary: 'model text' }),
      }),
    ).rejects.toThrow('未保存')
    // A real PaneService replaces its immutable session, so capture the verified scope separately.
    const connection = fakeConnection(),
      base = { connectionId: 'c', scope: 'a' },
      changed = { connectionId: 'c', scope: 'b' }
    const pane = {
      verified: async () => ({ connection, session: base }),
      home: () => changed,
      userViews: { workspace: async () => 'w' },
    } as unknown as PaneService
    const service = new AnalysisService(pane, f.records as unknown as OryhRecordRemote, f.storage)
    await expect(service.preview({ ...f.request, definition: f.definition })).rejects.toThrow('已变化')
  })
})
it('turns a chart into a report without losing display or filters, and identifies a missing required field', () => {
  const base = {
    ...patchDefinition(defaultDefinition(), { summary: 'keep me' }),
    query: 'warehouse',
    filters: [{ field: 'status', value: 'active' }],
  }
  const report = patchDefinition(base, { kind: 'report', nextSteps: '逐项核对库存' })
  expect(report).toMatchObject({
    ...base,
    kind: 'report',
    nextSteps: '逐项核对库存',
    sections: base.sections.map(s => (s.id === 'nextSteps' ? { ...s, body: '逐项核对库存' } : s)),
  })
  expect(base.kind).toBe('chart')
  expect(patchDefinition(report, { summary: '' }).summary).toBe('')
  expect(() => validateDefinition({ ...base, display: undefined })).toThrow('display')
  expect(() => patchDefinition(base, { source: 'shipments' })).toThrow('修改字段')
})
it('cancellation while fetching cannot leave a saved definition', async () => {
  const f = fixture(),
    controller = new AbortController()
  f.records.recordList.mockImplementation(async () => {
    controller.abort()
    return { page: 1, pages: 1, total: 0, fetchedAt: '', rows: [] }
  })
  await expect(f.service.save({ ...f.request, definition: f.definition }, controller.signal)).rejects.toThrow()
  expect(f.db.size).toBe(0)
})

it('reads first-release definitions without losing text, and rejects conflicting duplicate representations', () => {
  const { sections: _sections, sort: _sort, topN: _topN, ...old } = defaultDefinition()
  const restored = definitionSchema.parse({ ...old, kind: 'report', summary: '历史摘要', nextSteps: '历史行动' })
  expect(restored.sort).toBe('label')
  expect(restored.topN).toBe(0)
  expect(restored.sections.map(s => s.body)).toEqual(['历史摘要', '', '历史行动'])
  expect(() => validateDefinition({ ...restored, summary: '与章节冲突' })).toThrow('summary')
})
it('ranks complete groups, keeps exact signed ordering and drills the remainder without label collisions', () => {
  const rows = [
    row('a', '', '', 'A'),
    row('b', '', '', 'B'),
    row('c', '', '', 'B'),
    row('d', '', '', '其他（2 个分组）'),
    row('e', '', '', '其他（2 个分组）'),
    row('f', '', '', '其他（2 个分组）'),
  ]
  const d = { ...defaultDefinition(), sort: 'value-desc' as const, topN: 1 }
  expect(patchDefinition(d, { title: '只改标题' })).toMatchObject({ sort: 'value-desc', topN: 1 })
  const groups = aggregate(d, rows)
  expect(groups.map(g => g.value)).toEqual(['3', '3'])
  expect(groups[1]!.mergedGroups).toBe(2)
  expect(groups[0]!.key).toBe(groups[1]!.key)
  expect(groupId(groups[0]!)).not.toBe(groupId(groups[1]!))
  expect(groups[1]!.rowIds.sort()).toEqual(['a', 'b', 'c'])
  expect(groups.reduce((n, g) => n + g.count, 0)).toBe(rows.length)
  expect(aggregate({ ...d, topN: 0 }, rows)).toHaveLength(3)
  expect(aggregate({ ...d, topN: 0, sort: 'value-asc' }, rows).map(g => g.value)).toEqual(['1', '2', '3'])
  expect(() => validateDefinition({ ...d, sort: 'label' })).toThrow('从高到低')
  const money = {
    ...defaultDefinition(),
    source: 'sales-orders' as const,
    groupBy: 'currency',
    measure: 'total_amount',
    sort: 'value-desc' as const,
  }
  expect(
    aggregate(money, [
      row('1', '订单总额', '900000000000000.000001', 'CNY'),
      row('2', '订单总额', '900000000000000.000002', 'USD'),
      row('3', '订单总额', '-1', 'EUR'),
    ]).map(g => g.key),
  ).toEqual(['USD', 'CNY', 'EUR'])
  expect(() => validateDefinition({ ...money, topN: 1 })).toThrow('不能合并')
  expect(aggregate(d, [])).toEqual([])
})
it('edits and reorders stable sections while preserving other sections, settings and legacy fields', () => {
  const base = patchDefinition(defaultDefinition(), { kind: 'report', summary: '保留摘要', nextSteps: '行动' })
  const added = changeSection(base, {
    action: 'add',
    sectionId: 'custom-1',
    title: '风险',
    body: '没有证据不编造',
    afterId: 'summary',
  })
  expect(added.sections.map(s => s.id)).toEqual(['summary', 'custom-1', 'findings', 'nextSteps'])
  const changed = changeSection(added, { action: 'update', sectionId: 'custom-1', body: '核对来源' })
  expect(changed.summary).toBe('保留摘要')
  expect(changed.nextSteps).toBe('行动')
  const moved = changeSection(changed, { action: 'move', sectionId: 'custom-1', afterId: '' })
  expect(moved.sections[0]!.title).toBe('风险')
  const removed = changeSection(moved, { action: 'remove', sectionId: 'summary' })
  expect(removed.summary).toBe('')
  expect(removed.sections.some(s => s.id === 'summary')).toBe(false)
  expect(patchDefinition(removed, { summary: '重新添加' }).sections.at(-1)).toMatchObject({
    id: 'summary',
    body: '重新添加',
  })
  expect(() => changeSection(base, { action: 'move', sectionId: 'summary', afterId: 'missing' })).toThrow('目标章节')
  expect(() => changeSection(base, { action: 'move', sectionId: 'summary', afterId: 'summary' })).toThrow('自身')
  expect(() => changeSection(defaultDefinition(), { action: 'remove', sectionId: 'summary' })).toThrow('改成报告')
  expect(base.sections.map(s => s.id)).toEqual(['summary', 'findings', 'nextSteps'])
})
it('keeps new presentation and section edits after saving and reopening, and rejects edits arriving during a read', async () => {
  const f = fixture()
  const definition = changeSection(patchDefinition(f.definition, { kind: 'report', sort: 'value-desc', topN: 1 }), {
    action: 'add',
    sectionId: 'detail',
    title: '核对',
    body: '手工文字',
  })
  const first = await f.service.save({ ...f.request, definition })
  expect((await f.service.load({ ...f.request, id: first.document.id })).document.definition).toEqual(definition)
  f.records.recordList.mockImplementation(async () => {
    f.session.context = {
      key: `analytics:${first.document.id}`,
      detail: 'Unsaved changes',
      content: JSON.stringify({ dirty: true, definition: patchDefinition(definition, { summary: '读数期间的手改' }) }),
    }
    return { page: 1, pages: 1, total: 0, fetchedAt: '', rows: [] }
  })
  await expect(
    f.service.save({
      ...f.request,
      id: first.document.id,
      expectedVersion: 1,
      definition: patchDefinition(definition, { title: '模型标题' }),
    }),
  ).rejects.toThrow('未保存')
  expect((await f.service.list(f.request))[0]!.version).toBe(1)
})
