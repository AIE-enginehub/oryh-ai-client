/**
 * The old analyses and reports, carried over to custom pages (docs/48 §7).
 *
 * A converted analysis becomes a page whose task makes exactly one calculation — the one the old
 * definition described — and whose template draws it the way the old one did. Report sections become
 * fixed content, in their order, word for word. Nothing is run: an old analysis kept no result, so a
 * migrated page has none until its first refresh. What cannot be carried over faithfully is refused with
 * the reason, and the old analysis stays where it is.
 */
import { recordColumns, recordSpecs } from '@oryh/ai-client-records'
import type { CalculationRequest } from './custom-calculation.js'
import { type CustomDefinition, customDefinitionSchema } from './custom-model.js'
import { type AnalysisDocument, sources } from './model.js'

type Source = CustomDefinition['task']['sources'][number]

export type Migration =
  | { readonly definition: CustomDefinition; readonly notes: readonly string[] }
  | { readonly error: string }

/** Detail rows carry an inventory position's id; its product, warehouse and status live on the position. */
const THROUGH_POSITION: Readonly<Record<string, string>> = {
  product_code: 'product_code',
  facility: 'facility',
  item_status: 'status',
}
const TITLE_LENGTH = 24

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** The page's title: the old one, shortened to what a menu entry holds, and never one already taken. */
export function migratedTitle(title: string, taken: ReadonlySet<string>): string {
  const fit = (text: string, suffix = '') =>
    (text.length + suffix.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - suffix.length - 1)}…` : text) + suffix
  const base = fit(title.trim())
  if (!taken.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const next = fit(title.trim(), `（${n}）`)
    if (!taken.has(next)) return next
  }
  return fit(title.trim(), `（${Date.now() % 1000}）`)
}

/**
 * One old analysis as a custom page definition, or why it cannot be one.
 * @param document - the analysis as stored.
 * @param title - the page title to use (see migratedTitle).
 */
export function migrateAnalysis(document: AnalysisDocument, title: string): Migration {
  const d = document.definition
  const notes: string[] = []
  if (d.productIds.length)
    return {
      error: '按产品多选的库存流水无法迁移：新页面的来源筛选每个字段只能有一个值。请在新页面里改用产品编码筛选或分组。',
    }
  const labels = recordColumns(d.source)
  const filters: Record<string, string> = Object.fromEntries(d.filters.map(f => [f.field, f.value]))
  const query = recordSpecs[d.source].query
  if (d.query.trim()) {
    if (filters[query] !== undefined && filters[query] !== d.query.trim())
      return { error: `关键词和筛选都用到了 ${query}，新页面的来源筛选里放不下两个值。` }
    filters[query] = d.query.trim()
  }
  // A detail row reaches its product, warehouse and status through its position, as the old analysis
  // looked them up; the page reads the positions as a second source and joins on the position id.
  const viaPosition = d.source === 'inventory-item-details'
  const field = (name: string) =>
    viaPosition && THROUGH_POSITION[name] ? `inventory-items.${THROUGH_POSITION[name]}` : name
  const measure = d.measure === 'count' ? undefined : d.measure
  // An old sum was only ever saved grouped by what makes its figures addable — the currency of an amount,
  // the product or position of a quantity — so that grouping is the unit, and nothing is mixed.
  const unit = measure === undefined ? undefined : field(d.groupBy)
  const own = (name: string | undefined) => (name && !name.includes('.') ? [name] : [])
  // The positions are read, and joined, only when the grouping or the unit is one of theirs.
  const needsPositions = [field(d.groupBy), unit].some(name => name?.startsWith('inventory-items.'))
  const primaryFields = [
    ...new Set([
      ...own(field(d.groupBy)),
      ...own(measure),
      ...own(unit),
      ...(needsPositions ? ['inventory_item_id'] : []),
    ]),
  ]
  const primary: Source = {
    collection: d.source,
    filters,
    display: { columns: primaryFields.map(name => ({ field: name, label: labels[name] ?? name })) },
  }
  const positions: Source | undefined = needsPositions
    ? {
        collection: 'inventory-items',
        filters: {},
        display: {
          columns: [
            ...new Set(
              [field(d.groupBy), unit]
                .filter((name): name is string => !!name && name.startsWith('inventory-items.'))
                .map(name => name.slice('inventory-items.'.length)),
            ),
          ].map(name => ({ field: name, label: recordColumns('inventory-items')[name] ?? name })),
        },
      }
    : undefined
  if (positions)
    notes.push('库存流水的产品、仓库和状态取自对应的库存项；库存项超过 1000 条时刷新会失败，需要先加筛选。')
  const calculation: CalculationRequest = {
    collection: d.source,
    operation: measure ? 'sum' : 'count',
    groupBy: field(d.groupBy),
    ...(measure ? { measure, unitField: unit! } : { missingGroup: 'label' as const }),
    sort: d.sort,
    ...(d.topN ? { top: d.topN } : {}),
    ...(needsPositions ? { join: { collection: 'inventory-items', localField: 'inventory_item_id' } } : {}),
  }
  const groupLabel = labels[d.groupBy] ?? d.groupBy
  const measureLabel = measure ? (labels[measure] ?? measure) : '记录数'
  const scope = [
    `来源：${sources[d.source].title}`,
    `分组：${groupLabel}`,
    `指标：${measureLabel}`,
    ...(Object.keys(filters).length
      ? [
          `筛选：${Object.entries(filters)
            .map(([k, v]) => `${labels[k] ?? k}=${v}`)
            .join('，')}`,
        ]
      : []),
    ...(d.topN ? [`前 ${d.topN} 项，其余合并为“其他”`] : []),
  ].join('；')
  const sections = d.sections
    .map(
      section =>
        `<section class="oryh-section" data-section="${escape(section.id)}"><h2>${escape(section.title)}</h2><div class="oryh-body">${escape(section.body)}</div></section>`,
    )
    .join('')
  const html = [
    `<main><h1>${escape(d.title)}</h1><p class="oryh-scope">${escape(scope)}</p>`,
    d.display === 'bar'
      ? '<div data-oryh-chart="bar" data-oryh-data="rows" data-oryh-label="label" data-oryh-value="value"></div>'
      : '',
    `<table data-oryh-sortable><thead><tr><th>${escape(groupLabel)}</th><th>${escape(measureLabel)}</th>`,
    // A count is its own record count; a sum shows its unit and how many records it adds up.
    measure ? `<th>${d.source === 'sales-orders' ? '币种' : '产品'}</th><th>记录数</th>` : '',
    '</tr></thead><template data-oryh-each="rows"><tr><td data-oryh-field="label"></td>',
    `<td data-oryh-field="value" data-oryh-format="number"></td>`,
    measure ? '<td data-oryh-field="unit"></td><td data-oryh-field="count"></td>' : '',
    '</tr></template><tbody></tbody></table>',
    '<p class="oryh-scope">共 <span data-oryh-field="total"></span> 条记录参与统计。</p>',
    sections,
    '</main>',
  ].join('')
  if (html.length > 100_000) return { error: '报告正文超过新页面模板的 100 KB 上限。' }
  const instruction = [
    `这是从旧分析“${d.title}”迁移来的页面，口径必须与旧分析一致。`,
    `读取来源 ${d.source}${positions ? ' 和 inventory-items' : ''} 后，调用一次 oryh_custom_page_calculate，参数严格为：${JSON.stringify(calculation)}。`,
    '把返回的 groups 按返回的顺序原样写成 rows：label 为 group（多个分组字段时用“ / ”连接），value 为 value，count 为 count，unit 为 unit（unit 为 null 时不写这个键，不要写 null）。',
    'total 为返回的 matchedRows。不要增删、合并或重排分组，不要自己计算，不要写分析文字。',
  ].join('')
  const parsed = customDefinitionSchema.safeParse({
    title,
    html,
    // The workbench's theme styles the page; this is layout only.
    css: '.oryh-scope{color:var(--muted);font-size:12px}.oryh-body{white-space:pre-wrap;line-height:1.7}',
    script: '',
    fixedText: '',
    task: {
      instruction,
      timeZone: 'Asia/Shanghai',
      sources: positions ? [primary, positions] : [primary],
      contract: {
        fields: [
          {
            name: 'rows',
            type: 'array',
            required: true,
            fields: [
              { name: 'label', type: 'string', required: true },
              { name: 'value', type: 'string', required: true },
              { name: 'count', type: 'number', required: true },
              { name: 'unit', type: 'string', required: false },
            ],
          },
          { name: 'total', type: 'number', required: true },
        ],
      },
    },
  })
  if (!parsed.success) return { error: `转换后的定义无效：${parsed.error.issues[0]?.message ?? '未知原因'}` }
  if (title !== d.title) notes.push(`标题超过 ${TITLE_LENGTH} 个字或与已有页面重名，改为“${title}”。`)
  return { definition: parsed.data, notes }
}
