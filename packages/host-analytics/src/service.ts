import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@oryh/ai-client-foundation'
import { canAccessPage, requirePage } from '@oryh/ai-client-pages'
import { type BusinessRecord, type OryhRecordRemote, recordColumns } from '@oryh/ai-client-records'
import type { PaneService } from '@oryh/dsh-pane'
import {
  type AnalysisApi,
  type AnalysisDefinition,
  type AnalysisIdRequest,
  type AnalysisPreviewRequest,
  type AnalysisRequest,
  type AnalysisResult,
  type AnalysisSaveRequest,
  aggregate,
  fail,
  sources,
  validateDefinition,
} from './model.js'
import type { AnalysisStorage } from './storage.js'
/** Draft protection reads structured state, never a translated caption. */
export function analysisHasUnsaved(context: { key: string; content?: string } | undefined): boolean {
  if (!context?.key.startsWith('analytics:') || !context.content) return false
  try {
    return JSON.parse(context.content)?.dirty === true
  } catch {
    return true
  }
}
export const MAX_ANALYSIS_ROWS = 1000
/** Definitions only are durable. Source records are freshly authorized and read on every load. */
export class AnalysisService implements AnalysisApi {
  private serial: Promise<unknown> = Promise.resolve()
  constructor(
    private pane: PaneService,
    private records: OryhRecordRemote,
    private storage: AnalysisStorage,
  ) {}
  async scope(r: AnalysisRequest) {
    const { connection, session } = await this.pane.verified(r.sessionId)
    if (connection.id !== r.connectionId) throw fail('分析所属企业与当前会话不一致。')
    requirePage(connection.identity, 'analytics')
    const workspace = await this.pane.userViews.workspace(r.sessionId)
    return { connection, session, key: `${workspace} ${session.scope}` }
  }
  private assertScope(r: AnalysisRequest, scope: Awaited<ReturnType<AnalysisService['scope']>>) {
    const now = this.pane.home(r.sessionId)
    if (now.connectionId !== r.connectionId || now.scope !== scope.session.scope)
      throw fail('企业或会话已变化，分析请求已取消。')
  }
  async list(r: AnalysisRequest) {
    const scope = await this.scope(r),
      documents = await this.storage.read(scope.key)
    this.assertScope(r, scope)
    return documents.filter(d => canAccessPage(scope.connection.identity, d.definition.source))
  }
  async load(r: AnalysisIdRequest) {
    const document = (await this.list(r)).find(d => d.id === r.id)
    if (!document) throw fail('分析不存在或当前账号没有访问权限。')
    return { document, result: await this.preview({ ...r, definition: document.definition }) }
  }
  async preview(r: AnalysisPreviewRequest, signal?: AbortSignal): Promise<AnalysisResult> {
    signal?.throwIfAborted()
    const d = validateDefinition(r.definition),
      scope = await this.scope(r)
    requirePage(scope.connection.identity, d.source)
    const startedAt = new Date().toISOString(),
      rows: BusinessRecord[] = [],
      ids = new Set<string>()
    let expectedTotal: number | undefined, expectedPages: number | undefined
    for (let page = 1; page <= 50; page++) {
      signal?.throwIfAborted()
      const data = await this.records.recordList({
        connectionId: r.connectionId,
        kind: d.source,
        page,
        query: d.query,
        filters: Object.fromEntries(d.filters.map(f => [f.field, f.value])),
        ...(d.productIds.length ? { productIds: d.productIds } : {}),
      })
      signal?.throwIfAborted()
      this.assertScope(r, scope)
      if (data.total > MAX_ANALYSIS_ROWS || data.pages > 50)
        throw fail(`结果超过分析上限（${MAX_ANALYSIS_ROWS} 条 / 50 页），请先缩小筛选范围。未生成部分统计。`)
      if (expectedTotal !== undefined && (expectedTotal !== data.total || expectedPages !== data.pages))
        throw fail('读取期间数据总量改变，请刷新后重试。')
      expectedTotal = data.total
      expectedPages = data.pages
      for (const row of data.rows) {
        if (ids.has(row.id)) throw fail('跨页出现重复记录，不能可靠合计，请刷新重试。')
        ids.add(row.id)
        rows.push(row)
      }
      if (page >= data.pages) break
    }
    if (rows.length !== expectedTotal) throw fail('未读取完整查询结果，未生成部分统计。')
    const final = await this.scope(r)
    if (final.key !== scope.key) throw fail('分析所属工作区已改变。')
    requirePage(final.connection.identity, d.source)
    const labels = recordColumns(d.source)
    return {
      groups: aggregate(d, rows),
      rows,
      total: rows.length,
      startedAt,
      fetchedAt: new Date().toISOString(),
      sourceTitle: sources[d.source].title,
      groupLabel: labels[d.groupBy]!,
      measureLabel: d.measure === 'count' ? '记录数' : labels[d.measure]!,
      source: d.source,
      groupBy: d.groupBy,
      measure: d.measure,
      notice:
        '当前筛选的全部可见记录；分页读取不是事务快照。记录数不等于产品数量。说明为用户或 AI 撰写，刷新数据不会重写说明。',
    }
  }
  async save(r: AnalysisSaveRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const definition = validateDefinition(r.definition)
    const before = await this.scope(r)
    // Never replace text being hand-edited in the active pane, even if the stored version is unchanged.
    const assertDraft = () => {
      const context = this.pane.home(r.sessionId).context
      if (r.id && context?.key === `analytics:${r.id}` && analysisHasUnsaved(context) && context.content) {
        const visible = JSON.parse(context.content) as { definition?: AnalysisDefinition }
        if (canonicalJson(validateDefinition(visible.definition)) !== canonicalJson(definition))
          throw fail('页面有未保存修改，请先保存或放弃，再让 Chat 修改。')
      }
    }
    assertDraft()
    const result = await this.preview({ ...r, definition }, signal)
    const task = this.serial.then(async () => {
      signal?.throwIfAborted()
      const scope = await this.scope(r)
      if (scope.key !== before.key) throw fail('工作区或企业已变化。')
      requirePage(scope.connection.identity, definition.source)
      const documents = await this.storage.read(scope.key),
        old = documents.find(d => d.id === r.id)
      if (r.id && (!old || old.version !== r.expectedVersion)) throw fail('分析已被其他操作修改，请重新打开后再保存。')
      if (old) requirePage(scope.connection.identity, old.definition.source)
      if (!r.id && documents.length >= 50) throw fail('当前工作区最多保存 50 份分析。')
      this.assertScope(r, scope)
      const document = {
        id: old?.id ?? randomUUID(),
        version: (old?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        definition,
      }
      signal?.throwIfAborted()
      assertDraft()
      await this.storage.write(scope.key, [...documents.filter(d => d.id !== document.id), document])
      return { document, result }
    })
    this.serial = task.catch(() => {})
    return task
  }
}
