import type { BusinessRecord } from '@oryh/ai-client-records'
import type { CustomDefinition, CustomJson } from './custom-model.js'
import { customFail } from './custom-model.js'
import { decimal, decimalText } from './model.js'

type Source = CustomDefinition['task']['sources'][number]

/** One row of a dataset: its id and each field as text, nested objects as `a.b`. */
export interface DatasetRow {
  id: string
  values: Readonly<Record<string, string>>
}
/** What a run read, under the name it gave it: a declared source, or what one ORYH path answered. */
export interface Dataset {
  name: string
  rows: readonly DatasetRow[]
  /** Every field any row has. */
  fields: ReadonlySet<string>
  /** Whether `fields` is complete without rows: a declared source's saved columns are. */
  declared?: boolean
}

/** A declared source's rows as a dataset: its saved columns by field name, and the id. */
export function recordsDataset(source: Source, rows: readonly BusinessRecord[]): Dataset {
  const fields = new Set(['id', ...source.display.columns.map(column => column.field)])
  return {
    name: source.collection,
    fields,
    declared: true,
    rows: rows.map(row => ({
      id: row.id,
      values: Object.fromEntries([
        ['id', row.id],
        ...source.display.columns.map((column, index) => [column.field, row.fields[index + 1]?.value ?? ''] as const),
      ]),
    })),
  }
}

/** Flatten one JSON value into text fields: nested objects as `a.b` (two levels), lists left out. */
function flatten(value: Record<string, CustomJson>, into: Record<string, string>, prefix = '', depth = 0) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key
    if (item === null) into[name] = ''
    else if (Array.isArray(item)) continue
    else if (typeof item === 'object') {
      if (depth < 2) flatten(item, into, name, depth + 1)
    } else into[name] = String(item)
  }
  return into
}

/**
 * What ORYH answered, as a dataset: each object of the list is a row, flattened; a row's id is its `id`,
 * or its position when it has none.
 */
export function jsonDataset(name: string, items: readonly CustomJson[]): Dataset {
  const fields = new Set<string>()
  const rows = items.map((item, index) => {
    const values =
      item && typeof item === 'object' && !Array.isArray(item) ? flatten(item, {}) : { value: String(item ?? '') }
    for (const key of Object.keys(values)) fields.add(key)
    return { id: values.id || `#${index + 1}`, values }
  })
  return { name, rows, fields }
}

/** One condition a row must meet. Dates compare in the page's time zone; a bound is a local date or date-time. */
export interface CalculationCondition {
  field: string
  op: 'eq' | 'ne' | 'in' | 'not_in' | 'from' | 'before' | 'empty' | 'not_empty'
  value?: string | string[]
}

export interface CalculationRequest {
  /** The dataset: a declared source's collection, or the name a fetch gave what it read. */
  collection: string
  operation: 'count' | 'sum' | 'count_distinct'
  /** A field, `field@day|month|year` for a date bucket, or several of them. */
  groupBy?: string | string[]
  measure?: string
  unitField?: string
  where?: CalculationCondition[]
  /**
   * Fields of another dataset the run has read, reached through a key: `localField` of this row equals
   * `foreignField` (default `id`) of exactly one row there. Its fields are named `dataset.field`.
   */
  join?: { collection: string; localField: string; foreignField?: string; unmatched?: 'fail' | 'exclude' }
  /** Count rows whose group is empty under 未填写 instead of refusing; a sum still refuses. */
  missingGroup?: 'fail' | 'label'
  /** Order of the groups; by label unless asked otherwise. */
  sort?: 'label' | 'value-desc' | 'value-asc'
  /** Keep the first N groups and merge the rest into one 其他 group: record counts only, highest first. */
  top?: number
}

/** What a calculation may reach besides its own dataset: the page's time zone, and every dataset read. */
export interface CalculationContext {
  timeZone: string
  others?: ReadonlyMap<string, Dataset>
}

const MISSING = new Set(['', '—'])
const UNFILLED = '（未填写）'
const ROW_IDS = 50
const BUCKETS = new Set(['day', 'month', 'year'])

/** A field's text, or the row id. */
function valueOf(row: DatasetRow, name: string): string {
  return name === 'id' ? row.id : (row.values[name] ?? '')
}

/** Whether a dataset has a field. An empty read one may: it has no rows to say otherwise. */
function known(dataset: Dataset, name: string): boolean {
  return name === 'id' || dataset.fields.has(name) || (!dataset.rows.length && !dataset.declared)
}

/**
 * A date or date-time as the page's time zone reads it: `YYYY-MM-DD` stays as it is, and an instant
 * becomes `YYYY-MM-DDTHH:mm:ss` there, so "this month" means the month the people using the page live in.
 */
export function localTime(value: string, timeZone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const instant = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(instant.getTime())) customFail(`“${value}”不是可比较的日期。`)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map(part => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

function bound(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value))
    customFail('日期条件须是本地日期 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。')
  return value
}

/** Exact, source-backed arithmetic over fully read ORYH result sets. */
export function calculateRows(
  dataset: Dataset,
  request: CalculationRequest,
  context: CalculationContext = { timeZone: 'UTC' },
) {
  const rows = dataset.rows
  const join = request.join
  const joined = join ? context.others?.get(join.collection) : undefined
  if (join) {
    if (join.collection === dataset.name) customFail('关联须指向另一个数据集。')
    if (!joined) customFail(`关联的数据集 ${join.collection} 本次运行还没有读取。`)
    if (!known(dataset, join.localField) || !known(joined, join.foreignField ?? 'id'))
      customFail('关联字段不在数据集中。')
  }
  const index = new Map<string, DatasetRow>()
  if (join && joined) {
    for (const other of joined.rows) {
      const key = valueOf(other, join.foreignField ?? 'id')
      if (MISSING.has(key)) continue
      if (index.has(key))
        customFail(`关联键 ${join.foreignField ?? 'id'} 在 ${join.collection} 中不唯一，不能可靠关联。`)
      index.set(key, other)
    }
  }
  /**
   * A reference is this dataset's field — nested ones as `a.b` — or `dataset.field` of the joined one.
   * A name the dataset has is its own field first, so a flattened `customer.name` is not taken for a join.
   */
  const reference = (name: string) => {
    const prefix = join ? `${join.collection}.` : undefined
    if (!prefix || !name.startsWith(prefix) || dataset.fields.has(name)) {
      if (!known(dataset, name)) customFail(`字段 ${name} 不在数据集 ${dataset.name} 中。`)
      return (row: DatasetRow) => valueOf(row, name)
    }
    const field = name.slice(prefix.length)
    if (!joined || !known(joined, field)) customFail(`字段 ${field} 不在数据集 ${join!.collection} 中。`)
    return (row: DatasetRow) => {
      const other = index.get(valueOf(row, join!.localField))
      return other ? valueOf(other, field) : ''
    }
  }
  const groupBy =
    request.groupBy === undefined ? [] : Array.isArray(request.groupBy) ? request.groupBy : [request.groupBy]
  if (groupBy.length > 3) customFail('最多按 3 个字段分组。')
  const groupers = groupBy.map(spec => {
    const [name, bucket] = spec.split('@') as [string, string | undefined]
    if (bucket !== undefined && !BUCKETS.has(bucket)) customFail('日期分组只支持 @day、@month、@year。')
    const read = reference(name)
    if (!bucket) return read
    const length = bucket === 'day' ? 10 : bucket === 'month' ? 7 : 4
    return (row: DatasetRow) => {
      const value = read(row)
      return MISSING.has(value) ? value : localTime(value, context.timeZone).slice(0, length)
    }
  })
  if (request.operation === 'sum' && (!request.measure || !request.unitField))
    customFail('精确求和必须指定数值字段和单位字段，不能混合币种或计量单位。')
  if (request.operation === 'count' && (request.measure || request.unitField))
    customFail('记录数计算不需要数值字段或单位字段。')
  if (request.operation === 'count_distinct' && (!request.measure || request.unitField))
    customFail('去重计数须指定 measure（要去重的字段），不需要单位字段。')
  if (request.missingGroup === 'label' && request.operation === 'sum')
    customFail('求和不能把缺失的分组归为未填写，那会把不同币种或单位混在一起。')
  if (request.top !== undefined) {
    if (!Number.isSafeInteger(request.top) || request.top < 1 || request.top > 50) customFail('top 须在 1 到 50 之间。')
    // Counts add up; distinct counts and sums in different units do not.
    if (request.operation !== 'count' || request.sort !== 'value-desc')
      customFail('前 N 项合并只用于记录数，且须按数值从高到低排序。')
  }
  const measure = request.measure ? reference(request.measure) : undefined
  const unit = request.unitField ? reference(request.unitField) : undefined
  const conditions = (request.where ?? []).map(condition => {
    const read = reference(condition.field)
    const list = Array.isArray(condition.value) ? condition.value : undefined
    switch (condition.op) {
      case 'eq':
      case 'ne':
        if (typeof condition.value !== 'string') customFail(`条件 ${condition.op} 须给一个值。`)
        return (row: DatasetRow) => (read(row) === condition.value) === (condition.op === 'eq')
      case 'in':
      case 'not_in':
        if (!list?.length) customFail(`条件 ${condition.op} 须给一组值。`)
        return (row: DatasetRow) => list.includes(read(row)) === (condition.op === 'in')
      case 'from':
      case 'before': {
        const limit = bound(condition.value)
        return (row: DatasetRow) => {
          const value = read(row)
          if (MISSING.has(value)) customFail(`字段 ${condition.field} 有缺失的日期，不能可靠按时间筛选。`)
          const local = localTime(value, context.timeZone)
          return condition.op === 'from' ? local >= limit : local < limit
        }
      }
      case 'empty':
      case 'not_empty':
        return (row: DatasetRow) => MISSING.has(read(row)) === (condition.op === 'empty')
      default:
        return customFail(`不支持的条件 ${String(condition.op)}。`)
    }
  })
  const excluded: string[] = []
  const matched = rows.filter(row => {
    if (join && !index.has(valueOf(row, join.localField))) {
      if (join.unmatched !== 'exclude')
        customFail(
          `${dataset.name} 有记录在 ${join.collection} 中找不到对应项；确认后可设 unmatched: "exclude" 排除并披露。`,
        )
      excluded.push(row.id)
      return false
    }
    return conditions.every(test => test(row))
  })
  const groups = new Map<
    string,
    {
      group: string | string[] | null
      unit: string | null
      count: number
      value: bigint
      seen: Set<string>
      rowIds: string[]
    }
  >()
  for (const row of matched) {
    const keys = groupers.map(read => {
      const value = read(row)
      return MISSING.has(value) && request.missingGroup === 'label' ? UNFILLED : value
    })
    const unitValue = unit ? unit(row) : null
    if (keys.some(key => MISSING.has(key)) || (unitValue !== null && MISSING.has(unitValue)))
      customFail('分组或单位字段缺失，不能可靠汇总；记录数可设 missingGroup: "label" 归为未填写。')
    const group = keys.length === 0 ? null : keys.length === 1 ? keys[0]! : keys
    const key = JSON.stringify([group, unitValue])
    const current = groups.get(key) ?? { group, unit: unitValue, count: 0, value: 0n, seen: new Set(), rowIds: [] }
    current.count++
    if (current.rowIds.length < ROW_IDS) current.rowIds.push(row.id)
    if (request.operation === 'sum') current.value += decimal(measure!(row))
    if (request.operation === 'count_distinct') {
      const value = measure!(row)
      if (MISSING.has(value)) customFail(`字段 ${request.measure} 有缺失值，不能可靠去重计数。`)
      current.seen.add(value)
    }
    groups.set(key, current)
  }
  // An empty ungrouped query still has a known zero. Grouped queries have no invented category.
  if (!matched.length && !groupers.length && request.operation !== 'sum')
    groups.set('[null,null]', { group: null, unit: null, count: 0, value: 0n, seen: new Set(), rowIds: [] })
  const amount = (item: { count: number; value: bigint; seen: Set<string> }) =>
    request.operation === 'sum'
      ? item.value
      : BigInt(request.operation === 'count' ? item.count : item.seen.size) * 1_000_000n
  const byLabel = (a: { group: unknown; unit: unknown }, b: { group: unknown; unit: unknown }) =>
    String(a.group).localeCompare(String(b.group), 'zh-CN') || String(a.unit).localeCompare(String(b.unit), 'zh-CN')
  const ordered = [...groups.values()].sort((a, b) => {
    if (request.sort === 'value-desc' || request.sort === 'value-asc') {
      const delta = amount(a) - amount(b)
      if (delta) return (delta < 0n ? -1 : 1) * (request.sort === 'value-desc' ? -1 : 1)
    }
    return byLabel(a, b)
  })
  const shown = request.top && ordered.length > request.top ? ordered.slice(0, request.top) : ordered
  const rest = ordered.slice(shown.length)
  return {
    collection: dataset.name,
    operation: request.operation,
    groupBy: request.groupBy ?? null,
    measure: request.measure ?? null,
    unitField: request.unitField ?? null,
    ...(request.where?.length ? { where: request.where } : {}),
    ...(join ? { join, excluded: { count: excluded.length, rowIds: excluded.slice(0, ROW_IDS) } } : {}),
    totalRows: rows.length,
    matchedRows: matched.length,
    groups: [
      ...shown.map(item => ({
        group: item.group,
        unit: item.unit,
        count: item.count,
        value:
          request.operation === 'sum'
            ? decimalText(item.value)
            : String(request.operation === 'count' ? item.count : item.seen.size),
        rowIds: item.rowIds,
        ...(item.count > item.rowIds.length ? { rowIdsTruncated: true } : {}),
      })),
      ...(rest.length
        ? [
            {
              group: `其他（${rest.length} 个分组）`,
              unit: null,
              count: rest.reduce((n, item) => n + item.count, 0),
              value: String(rest.reduce((n, item) => n + item.count, 0)),
              rowIds: rest.flatMap(item => item.rowIds).slice(0, ROW_IDS),
              mergedGroups: rest.length,
            },
          ]
        : []),
    ],
    notice: '只计算本次完整读取的可见记录；分页读取不保证事务快照。',
  }
}
