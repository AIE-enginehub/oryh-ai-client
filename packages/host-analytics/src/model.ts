/** Browser-safe definitions. No SQL, scripts, HTML or model-supplied aggregate values. */
import { OryhClientError } from '@oryh/ai-client-foundation'
import { type BusinessRecord, type RecordKind, recordColumns } from '@oryh/ai-client-records'
import { z } from 'zod'

/** The same sources for an English page, keyed by the source id rather than by the Chinese title. */
export const sourceTitlesEn: Readonly<Record<string, string>> = {
  'sales-orders': 'Sales orders',
  'inventory-items': 'Inventory on hand',
  'inventory-item-details': 'Inventory movements',
}

export const sources = {
  'sales-orders': {
    title: '销售订单',
    dimensions: ['status', 'customer_name_snapshot', 'currency', 'order_kind'],
    measures: ['count', 'total_amount'],
  },
  'inventory-items': {
    title: '库存余额',
    dimensions: ['product_code', 'facility', 'status'],
    measures: ['count', 'quantity_on_hand', 'available_to_promise'],
  },
  'inventory-item-details': {
    title: '库存流水',
    dimensions: ['reason', 'product_code', 'facility', 'inventory_item_id'],
    measures: ['count', 'quantity_on_hand_diff', 'available_to_promise_diff'],
  },
  shipments: { title: '收发货', dimensions: ['direction', 'status', 'facility', 'carrier'], measures: ['count'] },
} satisfies Record<RecordKind, { title: string; dimensions: string[]; measures: string[] }>
const sectionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    title: z.string().trim().min(1).max(80),
    body: z.string().max(10000),
  })
  .strict()
export type AnalysisSection = z.infer<typeof sectionSchema>
const builtins = { summary: '摘要', findings: '观察与结论', nextSteps: '后续行动' } as const
const rawDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    kind: z.enum(['chart', 'report']),
    source: z.enum(['sales-orders', 'inventory-items', 'inventory-item-details', 'shipments']),
    query: z.string().max(200),
    filters: z
      .array(
        z.object({ field: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/), value: z.string().min(1).max(200) }).strict(),
      )
      .max(10),
    productIds: z.array(z.string().min(1).max(200)).max(50),
    groupBy: z.string().min(1).max(64),
    measure: z.string().min(1).max(64),
    display: z.enum(['bar', 'table']),
    sort: z.enum(['label', 'value-desc', 'value-asc']).default('label'),
    topN: z.number().int().min(0).max(50).default(0),
    sections: z.array(sectionSchema).max(20).optional(),
    summary: z.string().max(10000),
    findings: z.string().max(10000),
    nextSteps: z.string().max(10000),
  })
  .strict()
// Read-time normalization keeps first-release definitions and their report text usable.
export const definitionSchema = rawDefinitionSchema
  .superRefine((d, ctx) => {
    if (d.sections)
      for (const id of Object.keys(builtins) as (keyof typeof builtins)[]) {
        if (d[id] !== (d.sections.find(s => s.id === id)?.body ?? ''))
          ctx.addIssue({
            code: 'custom',
            path: [id],
            message: '正文与 sections 不一致，请用 analysis_section 或 analysis_update 局部修改。',
          })
      }
  })
  .transform(d => {
    const sections =
      d.sections ??
      Object.entries(builtins).map(([id, title]) => ({
        id,
        title,
        body: d[id as keyof typeof builtins],
      }))
    return {
      ...d,
      sections,
      ...Object.fromEntries(Object.keys(builtins).map(id => [id, sections.find(s => s.id === id)?.body ?? ''])),
    }
  })
export type AnalysisDefinition = z.infer<typeof definitionSchema>
export interface AnalysisDocument {
  id: string
  version: number
  updatedAt: string
  definition: AnalysisDefinition
}
export interface AnalysisGroup {
  key: string
  value: string
  count: number
  rowIds: string[]
  /** Stable drill identity; aggregate remainder never collides with a real label. */
  id?: string
  mergedGroups?: number
}
export interface AnalysisResult {
  groups: AnalysisGroup[]
  rows: BusinessRecord[]
  total: number
  startedAt: string
  fetchedAt: string
  sourceTitle: string
  groupLabel: string
  measureLabel: string
  /** Stable keys behind the labels, so a display can translate without looking up Chinese words. */
  source: string
  groupBy: string
  measure: string
  notice: string
}
export interface AnalysisRequest {
  sessionId: string
  connectionId: string
}
export interface AnalysisIdRequest extends AnalysisRequest {
  id: string
}
export interface AnalysisPreviewRequest extends AnalysisRequest {
  definition: AnalysisDefinition
}
export interface AnalysisSaveRequest extends AnalysisPreviewRequest {
  id?: string
  expectedVersion?: number
}
export interface AnalysisView {
  document: AnalysisDocument
  result: AnalysisResult
}
export interface AnalysisApi {
  list(request: AnalysisRequest): Promise<AnalysisDocument[]>
  load(request: AnalysisIdRequest): Promise<AnalysisView>
  preview(request: AnalysisPreviewRequest): Promise<AnalysisResult>
  save(request: AnalysisSaveRequest): Promise<AnalysisView>
}
export const fail = (message: string) => new OryhClientError(message, 'request-failed')
export function validateDefinition(value: unknown): AnalysisDefinition {
  const parsed = definitionSchema.safeParse(value)
  if (!parsed.success)
    throw fail(
      `分析定义字段无效或缺失：${[...new Set(parsed.error.issues.map(i => i.path.join('.') || 'definition'))].join('、')}。请按 analysis_catalog 的完整示例填写，或用 analysis_update 局部修改。`,
    )
  const d = parsed.data,
    source = sources[d.source]
  if (!(source.dimensions as string[]).includes(d.groupBy) || !(source.measures as string[]).includes(d.measure))
    throw fail('该数据源不支持此分组或指标，请先读取分析字段。')
  if (
    new Set(d.filters.map(f => f.field)).size !== d.filters.length ||
    new Set(d.productIds).size !== d.productIds.length
  )
    throw fail('筛选字段或产品编号重复。')
  if (d.productIds.length && d.source !== 'inventory-item-details') throw fail('产品多选仅用于库存流水分析。')
  if (d.measure === 'total_amount' && d.groupBy !== 'currency') throw fail('订单金额必须按币种分组，不能相加不同币种。')
  if (
    d.measure !== 'count' &&
    d.source.startsWith('inventory-') &&
    d.groupBy !== (d.source === 'inventory-items' ? 'product_code' : 'inventory_item_id')
  )
    throw fail('数量合计必须按产品编码（库存余额）或库存项编号（流水）分组，不能相加不同产品。')
  if (new Set(d.sections.map(s => s.id)).size !== d.sections.length) throw fail('报告章节编号重复。')
  if (d.sections.reduce((n, s) => n + s.body.length, 0) > 30000) throw fail('报告正文总长度不能超过 30000 字符。')
  if (d.topN && d.measure !== 'count') throw fail('前 N 项合并仅支持记录数；不能合并不同币种或产品的数值。')
  if (d.topN && d.sort !== 'value-desc') throw fail('前 N 项必须按指标从高到低排序；其余分组合并为其他。')
  return d
}
export function defaultDefinition(): AnalysisDefinition {
  return {
    title: '库存分布',
    kind: 'chart',
    source: 'inventory-items',
    query: '',
    filters: [],
    productIds: [],
    groupBy: 'facility',
    measure: 'count',
    display: 'bar',
    sort: 'label',
    topN: 0,
    sections: Object.entries(builtins).map(([id, title]) => ({ id, title, body: '' })),
    summary: '',
    findings: '',
    nextSteps: '',
  }
}
export function decimal(value: string): bigint {
  // Six decimal places, exact integer arithmetic. Unknown/missing values are errors, never zero.
  if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(value))
    throw fail('存在缺失或不支持精度的数值，无法可靠合计；请改用记录数或核对源数据。')
  const negative = value.startsWith('-'),
    [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.')
  const n = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))
  return negative ? -n : n
}
export function decimalText(value: bigint): string {
  const sign = value < 0n ? '-' : '',
    n = value < 0n ? -value : value
  const fraction = String(n % 1000000n)
    .padStart(6, '0')
    .replace(/0+$/, '')
  return `${sign}${n / 1000000n}${fraction ? `.${fraction}` : ''}`
}
export function aggregate(d: AnalysisDefinition, rows: BusinessRecord[]): AnalysisGroup[] {
  d = validateDefinition(d)
  const labels = recordColumns(d.source),
    groups = new Map<string, { count: number; value: bigint; rowIds: string[] }>()
  for (const row of rows) {
    const group = row.fields.find(f => f.label === labels[d.groupBy])?.value
    if (d.measure !== 'count' && (!group || group === '—')) throw fail('合计分组字段缺失，不能混合未知币种或产品。')
    const key = group && group !== '—' ? group : '（未填写）'
    const item = groups.get(key) ?? { count: 0, value: 0n, rowIds: [] }
    item.count++
    item.rowIds.push(row.id)
    item.value +=
      d.measure === 'count' ? 1000000n : decimal(row.fields.find(f => f.label === labels[d.measure])?.value ?? '')
    groups.set(key, item)
  }
  const ordered: AnalysisGroup[] = [...groups]
    .map(([key, g]) => ({ key, count: g.count, value: decimalText(g.value), rowIds: g.rowIds }))
    .sort((a, b) => {
      if (d.sort !== 'label') {
        const delta = BigInt(groups.get(a.key)!.value) - BigInt(groups.get(b.key)!.value)
        if (delta) return (delta < 0n ? -1 : 1) * (d.sort === 'value-desc' ? -1 : 1)
      }
      return a.key.localeCompare(b.key, 'zh-CN')
    })
  if (!d.topN || ordered.length <= d.topN) return ordered
  const rest = ordered.slice(d.topN)
  return [
    ...ordered.slice(0, d.topN),
    {
      id: '__remainder__',
      key: `其他（${rest.length} 个分组）`,
      value: String(rest.reduce((n, g) => n + g.count, 0)),
      count: rest.reduce((n, g) => n + g.count, 0),
      rowIds: rest.flatMap(g => g.rowIds),
      mergedGroups: rest.length,
    },
  ]
}

const patchSchema = rawDefinitionSchema
  .pick({
    title: true,
    kind: true,
    groupBy: true,
    measure: true,
    display: true,
    sort: true,
    topN: true,
    summary: true,
    findings: true,
    nextSteps: true,
  })
  .extend({ sort: rawDefinitionSchema.shape.sort.unwrap(), topN: rawDefinitionSchema.shape.topN.unwrap() })
  .partial()
  .strict()
export function patchDefinition(base: AnalysisDefinition, changes: unknown): AnalysisDefinition {
  const parsed = patchSchema.safeParse(changes)
  if (!parsed.success || !Object.keys(parsed.data).length)
    throw fail('修改字段无效，请仅传需要修改的标题、类型、分组、指标、显示或正文。')
  const sections = [...validateDefinition(base).sections]
  for (const [id, title] of Object.entries(builtins)) {
    const body = parsed.data[id as keyof typeof builtins]
    if (body === undefined) continue
    const i = sections.findIndex(s => s.id === id)
    if (i < 0) sections.push({ id, title, body })
    else sections[i] = { ...sections[i]!, body }
  }
  return validateDefinition({ ...base, ...parsed.data, sections })
}

export interface SectionChange {
  action: 'add' | 'update' | 'remove' | 'move'
  sectionId: string
  title?: string
  body?: string
  /** Empty means first; omitted means append on add, keep position otherwise. */
  afterId?: string
}
/** Shared by the page and tools. Stable ids, explicit anchors, no index-based overwrite. */
export function changeSection(base: AnalysisDefinition, change: SectionChange): AnalysisDefinition {
  const d = validateDefinition(base)
  if (d.kind !== 'report') throw fail('请先将图表改成报告，再编辑章节。')
  const sections = d.sections.map(s => ({ ...s }))
  const index = sections.findIndex(s => s.id === change.sectionId)
  if (change.action === 'add' ? index >= 0 : index < 0) throw fail('章节不存在或编号重复，请读取当前报告。')
  if (change.afterId === change.sectionId) throw fail('不能将章节移动到自身之后。')
  if (change.afterId && !sections.some(s => s.id === change.afterId)) throw fail('目标章节不存在，请读取当前报告。')
  if (change.action === 'add') {
    if (!change.title?.trim()) throw fail('新增章节需要标题。')
    const section = { id: change.sectionId, title: change.title, body: change.body ?? '' }
    const at =
      change.afterId === undefined
        ? sections.length
        : change.afterId === ''
          ? 0
          : sections.findIndex(s => s.id === change.afterId) + 1
    sections.splice(at, 0, section)
  } else if (change.action === 'remove') {
    sections.splice(index, 1)
  } else if (change.action === 'move') {
    if (change.afterId === undefined) throw fail('移动章节需要 afterId，空字符串表示第一节。')
    const [section] = sections.splice(index, 1)
    const at = change.afterId === '' ? 0 : sections.findIndex(s => s.id === change.afterId) + 1
    sections.splice(at, 0, section!)
  } else {
    if (change.title === undefined && change.body === undefined) throw fail('请提供要修改的章节标题或正文。')
    sections[index] = {
      ...sections[index]!,
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.body === undefined ? {} : { body: change.body }),
    }
  }
  return validateDefinition({
    ...d,
    sections,
    ...Object.fromEntries(Object.keys(builtins).map(id => [id, sections.find(s => s.id === id)?.body ?? ''])),
  })
}
export const groupId = (group: AnalysisGroup): string => group.id ?? `group:${group.key}`
