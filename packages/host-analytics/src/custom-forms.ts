/**
 * A custom page's forms (docs/48 §16): what a person fills in on the page, handed to the Chat agent once
 * they confirm it. The page writes nothing itself. The agent carries the submission out with its tools
 * and skills, as it would a request typed into Chat, and ORYH decides whether this person may.
 *
 * A form declares its fields and an instruction: what the agent is to do with a submission. Both are saved
 * with the page. The frame only says which form, which row of the result, and what was typed; the Host
 * holds each value to its field, reads the row and any chosen option from the page's own published
 * result, and composes what the person confirms and the agent receives.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ContractField, CustomJson } from './custom-model.js'
import { decimal, decimalText } from './model.js'

export interface CustomFormSource {
  /** A top-level array of the page's result. */
  data: string
  /** The item field submitted, such as a record id. */
  value: string
  /** The item field shown. */
  label: string
}
/** A figure the page shows as the person types; the confirmation shows the Host's own, exact figure. */
export interface CustomComputed {
  name: string
  label: string
  /** Two numeric fields of the same line multiplied. */
  multiply?: [string, string] | undefined
  /** A line figure or numeric line field summed over a lines field: `lines.field`. */
  sum?: string | undefined
  /** A checkbox of the line that makes the product zero, such as a gift. */
  zeroWhen?: string | undefined
}
/** Where a record field looks: an ORYH collection, and what a record of it is called by. */
export interface CustomLookup {
  /** The collection as its path names it: `customers`, `projects`. */
  collection: string
  /** The field shown as the record's name. */
  label: string
  /** A second field shown beside the name, such as a code or a number. */
  code?: string | undefined
}
export interface CustomFormField {
  name: string
  label: string
  /**
   * `record` is a form in the conversation's (chat-form.ts): one record of an ORYH collection, searched for
   * in a dialog — a customer, a project, a warehouse. `product` is the same thing for the product catalogue,
   * kept as the name the first forms used.
   */
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox' | 'record' | 'product' | 'lines'
  required: boolean
  /** Fixed choices of a select. */
  options?: string[] | undefined
  /** Choices of a select taken from the page's result. */
  source?: CustomFormSource | undefined
  /** A record field: the collection it chooses from, and which fields of a record name it. */
  lookup?: CustomLookup | undefined
  /** On a select with a source: sibling field ← field of the chosen item, filled in as a default. */
  defaults?: Record<string, string> | undefined
  /** Lines: how many at least and at most. */
  min?: number | undefined
  max?: number | undefined
  /** Lines: the fields of one line. */
  fields?: CustomFormField[] | undefined
  /** Lines: figures of each line. */
  computed?: CustomComputed[] | undefined
}
export interface CustomForm {
  /** What the template names in `data-oryh-form`. */
  name: string
  label: string
  /** What the agent is to do with a submission: the goal, and the skill to follow. */
  instruction: string
  fields: CustomFormField[]
  /** Form figures: sums over lines. */
  computed?: CustomComputed[] | undefined
}

const KEY = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
const label = z.string().trim().min(1).max(40)
const computedSchema = z
  .object({
    name: KEY,
    label,
    multiply: z.tuple([KEY, KEY]).optional(),
    sum: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}\.[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .optional(),
    zeroWhen: KEY.optional(),
  })
  .strict()
const plainField = z
  .object({
    name: KEY,
    label,
    type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'record', 'product']),
    required: z.boolean(),
    lookup: z
      .object({
        collection: z
          .string()
          .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
          .max(64),
        label: KEY,
        code: KEY.optional(),
      })
      .strict()
      .optional(),
    options: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
    source: z.object({ data: KEY, value: KEY, label: KEY }).strict().optional(),
    defaults: z.record(KEY, KEY).optional(),
  })
  .strict()
const linesField = z
  .object({
    name: KEY,
    label,
    type: z.literal('lines'),
    required: z.boolean(),
    min: z.number().int().min(0).max(50).default(0),
    max: z.number().int().min(1).max(50),
    fields: z.array(plainField).min(1).max(20),
    computed: z.array(computedSchema).max(10).optional(),
  })
  .strict()
export const customFormSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
    label: z.string().trim().min(1).max(24),
    instruction: z.string().trim().min(10).max(2000),
    fields: z
      .array(z.union([plainField, linesField]))
      .min(1)
      .max(20),
    computed: z.array(computedSchema).max(10).optional(),
  })
  .strict() as unknown as z.ZodType<CustomForm>

/** The fields of a top-level array of the contract, when the contract names them. */
function itemFields(contract: readonly ContractField[], name: string): Set<string> | undefined {
  const field = contract.find(item => item.name === name)
  if (field?.type !== 'array' || !field.fields) return undefined
  return new Set(field.fields.map(item => item.name))
}

/** Why a set of fields — a form's, or one line's — cannot be saved. */
function fieldIssues(
  where: string,
  fields: readonly CustomFormField[],
  contract: readonly ContractField[],
  inLines: boolean,
): string[] {
  const issues: string[] = []
  const names = new Set(fields.map(field => field.name))
  if (names.size !== fields.length) issues.push(`${where}：字段重复。`)
  for (const field of fields) {
    const at = `${where} 字段 ${field.name}`
    if (field.type === 'lines') {
      if ((field.min ?? 0) > (field.max ?? 0)) issues.push(`${at}：min 不能大于 max。`)
      issues.push(...fieldIssues(at, field.fields ?? [], contract, true))
      issues.push(...computedIssues(at, field.computed ?? [], field.fields ?? [], undefined))
      continue
    }
    // A page's form is drawn from the page's own result; the catalogue lookup is the conversation's.
    if (field.type === 'product' || field.type === 'record' || field.lookup)
      issues.push(`${at}：自定义页面的表单不支持 record、product 字段；要让用户从 ORYH 里选记录，用对话里的表单。`)
    if (field.type === 'select') {
      if (Boolean(field.options) === Boolean(field.source))
        issues.push(`${at}：下拉字段要么给 options（固定选项），要么给 source（取自页面数据），二选一。`)
      if (field.source) {
        const item = itemFields(contract, field.source.data)
        if (!item) issues.push(`${at}：数据约定里没有列出每项字段的数组 ${field.source.data}。`)
        else {
          for (const name of [field.source.value, field.source.label])
            if (!item.has(name)) issues.push(`${at}：${field.source.data} 的每项没有字段 ${name}。`)
          for (const [target, from] of Object.entries(field.defaults ?? {})) {
            if (!names.has(target) || target === field.name) issues.push(`${at}：默认值要填的 ${target} 不是同级字段。`)
            if (!item.has(from)) issues.push(`${at}：${field.source.data} 的每项没有字段 ${from}。`)
          }
        }
      }
      if (field.defaults && (!field.source || !inLines))
        issues.push(`${at}：defaults 只用于明细行里取自页面数据的下拉字段。`)
    } else if (field.options || field.source || field.defaults)
      issues.push(`${at}：只有下拉字段可以有 options、source 或 defaults。`)
  }
  return issues
}

/**
 * Why figures cannot be saved. A line multiplies two of its numbers; a form sums over one of its lines.
 * @param lines - for a form's figures, its lines fields by name; undefined for a line's own figures.
 */
function computedIssues(
  where: string,
  computed: readonly CustomComputed[],
  fields: readonly CustomFormField[],
  lines: ReadonlyMap<string, CustomFormField> | undefined,
): string[] {
  const issues: string[] = []
  const byName = new Map(fields.map(field => [field.name, field]))
  const names = new Set(computed.map(item => item.name))
  if (names.size !== computed.length) issues.push(`${where}：计算项重复。`)
  for (const item of computed) {
    const at = `${where} 计算项 ${item.name}`
    if (byName.has(item.name)) issues.push(`${at}：与字段同名。`)
    if (!lines) {
      if (!item.multiply || item.sum) issues.push(`${at}：明细行里的计算只能是 multiply（两个数相乘）。`)
      for (const name of item.multiply ?? [])
        if (byName.get(name)?.type !== 'number') issues.push(`${at}：${name} 不是这一行的数字字段。`)
      if (item.zeroWhen && byName.get(item.zeroWhen)?.type !== 'checkbox')
        issues.push(`${at}：zeroWhen 须是这一行的勾选框。`)
    } else {
      if (!item.sum || item.multiply || item.zeroWhen)
        issues.push(`${at}：表单上的计算只能是 sum（对明细的一列求和）。`)
      const [group, column] = (item.sum ?? '.').split('.') as [string, string]
      const line = lines.get(group)
      const summed =
        line?.fields?.some(field => field.name === column && field.type === 'number') ||
        line?.computed?.some(figure => figure.name === column)
      if (!summed) issues.push(`${at}：${item.sum} 不是某个明细的数字字段或计算项。`)
    }
  }
  return issues
}

/**
 * Why a page's forms cannot be saved, one line each; empty when they can.
 * @param forms - as the definition declares them.
 * @param contract - the page's data contract, where options taken from the result are declared.
 */
export function formIssues(forms: readonly CustomForm[], contract: readonly ContractField[]): string[] {
  const issues: string[] = []
  if (new Set(forms.map(form => form.name)).size !== forms.length) issues.push('表单名称重复。')
  for (const form of forms) {
    const where = `表单 ${form.name}`
    issues.push(...fieldIssues(where, form.fields, contract, false))
    const lines = new Map(form.fields.filter(field => field.type === 'lines').map(field => [field.name, field]))
    issues.push(...computedIssues(where, form.computed ?? [], form.fields, lines))
  }
  return issues
}

/**
 * The row of a result a form belongs to: `rows.3`, `groups.0.items.2`, or the result itself when empty.
 * Read from the page's own published result, never from what the frame says the row contains.
 */
export function resolveRow(data: Record<string, CustomJson>, path: string): Record<string, CustomJson> {
  if (path === '') return data
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}\.\d{1,5}(\.[A-Za-z_][A-Za-z0-9_]{0,63}\.\d{1,5}){0,3}$/.test(path))
    throw new Error('表单所在的行无效。')
  let current: CustomJson = data
  const parts = path.split('.')
  for (let index = 0; index < parts.length; index += 2) {
    const list: CustomJson | undefined =
      current && typeof current === 'object' && !Array.isArray(current) ? current[parts[index]!] : undefined
    const item: CustomJson | undefined = Array.isArray(list) ? list[Number(parts[index + 1])] : undefined
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('找不到这一行，页面数据可能已刷新。')
    current = item
  }
  return current as Record<string, CustomJson>
}

/** One submission, as the person confirms it and the agent receives it. */
export interface PreparedSubmission {
  label: string
  instruction: string
  /** The filled-in fields outside lines, by label, as shown. */
  entries: { label: string; value: string }[]
  /** Each lines field as a table: columns by label, then the page's figures. */
  lines: { label: string; columns: string[]; rows: string[][] }[]
  /** The form's figures, worked out exactly here. */
  computed: { label: string; value: string }[]
  /** The values by field name for the agent: a chosen option as its value and label, lines as a list. */
  values: Record<string, CustomJson>
  /** Taken over the form, row and values: what the agent receives is exactly what was confirmed. */
  digest: string
}

const isBlank = (raw: unknown) => raw === undefined || raw === null || raw === false || String(raw).trim() === ''

/** One field's value, held to its declaration: the value for the agent and the text shown. */
function fieldValue(
  field: CustomFormField,
  raw: unknown,
  data: Record<string, CustomJson>,
): { value: CustomJson; shown: string } | undefined {
  if (field.type === 'checkbox') {
    const checked = raw === true || raw === 'true' || raw === 'on'
    if (field.required && !checked) throw new Error(`请勾选“${field.label}”。`)
    return { value: checked, shown: checked ? '是' : '否' }
  }
  if (typeof raw !== 'string' && typeof raw !== 'number' && !isBlank(raw)) throw new Error(`“${field.label}”的值无效。`)
  const text = isBlank(raw) ? '' : String(raw).trim()
  if (!text) {
    if (field.required) throw new Error(`请填写“${field.label}”。`)
    return undefined
  }
  if (text.length > (field.type === 'textarea' ? 5000 : 500)) throw new Error(`“${field.label}”太长。`)
  if (field.type === 'number') {
    let exact: string
    try {
      exact = decimalText(decimal(text.replaceAll(',', '')))
    } catch {
      throw new Error(`“${field.label}”须是数字（最多 6 位小数）。`)
    }
    return { value: exact, shown: exact }
  }
  if (field.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text)))
      throw new Error(`“${field.label}”须是日期 YYYY-MM-DD。`)
    return { value: text, shown: text }
  }
  if (field.type === 'select' && field.options) {
    if (!field.options.includes(text)) throw new Error(`“${field.label}”的选项无效。`)
    return { value: text, shown: text }
  }
  if (field.type === 'select' && field.source) {
    // A choice is one the page showed: an item of its own result, never an id the frame made up.
    const items = data[field.source.data]
    const item = Array.isArray(items)
      ? items.find(
          (candidate): candidate is Record<string, CustomJson> =>
            !!candidate &&
            typeof candidate === 'object' &&
            !Array.isArray(candidate) &&
            String(candidate[field.source!.value] ?? '') === text,
        )
      : undefined
    if (!item) throw new Error(`“${field.label}”的选项不在页面数据里，请刷新页面后重选。`)
    const shown = String(item[field.source.label] ?? text)
    return { value: { value: text, label: shown }, shown }
  }
  return { value: text, shown: text }
}

/** A line's figures, exact: the product of two of its numbers, or zero where its checkbox says so. */
function lineFigures(line: Record<string, CustomJson>, computed: readonly CustomComputed[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of computed) {
    if (item.zeroWhen && line[item.zeroWhen] === true) {
      out[item.name] = '0'
      continue
    }
    const [a, b] = (item.multiply ?? []).map(name => line[name])
    if (typeof a !== 'string' || typeof b !== 'string') continue
    const product = decimal(a) * decimal(b)
    // Six places times six places: bring the product back to six, rounding half away from zero.
    const scaled = (product < 0n ? product - 500_000n : product + 500_000n) / 1_000_000n
    out[item.name] = decimalText(scaled)
  }
  return out
}

/**
 * Hold a submission to its form.
 * @param form - as the page's definition declares it.
 * @param values - what the frame collected, by field name; lines as a list of objects.
 * @param data - the page's published result, where chosen options must be.
 * @param rowPath - the row the form belongs to, for the digest.
 */
export function prepareSubmission(
  form: CustomForm,
  values: Readonly<Record<string, unknown>>,
  data: Record<string, CustomJson>,
  rowPath: string,
): PreparedSubmission {
  if (JSON.stringify(values ?? {}).length > 64_000) throw new Error('提交内容超过 64 KB。')
  const declared = new Set(form.fields.map(field => field.name))
  const stray = Object.keys(values ?? {}).find(name => !declared.has(name))
  if (stray) throw new Error(`表单没有字段 ${stray}。`)
  const result: PreparedSubmission = {
    label: form.label,
    instruction: form.instruction,
    entries: [],
    lines: [],
    computed: [],
    values: {},
    digest: '',
  }
  const linesByName = new Map<string, Record<string, CustomJson>[]>()
  const figuresByName = new Map<string, Record<string, string>[]>()
  for (const field of form.fields) {
    const raw = values?.[field.name]
    if (field.type !== 'lines') {
      const held = fieldValue(field, raw, data)
      if (!held) continue
      result.values[field.name] = held.value
      result.entries.push({ label: field.label, value: held.shown })
      continue
    }
    if (raw !== undefined && !Array.isArray(raw)) throw new Error(`“${field.label}”须是明细列表。`)
    const given = (raw ?? []) as unknown[]
    if (given.length > (field.max ?? 50)) throw new Error(`“${field.label}”最多 ${field.max} 行。`)
    const sub = field.fields ?? []
    const names = new Set(sub.map(item => item.name))
    const lines: Record<string, CustomJson>[] = []
    const rows: string[][] = []
    const figures: Record<string, string>[] = []
    for (const [index, line] of given.entries()) {
      if (!line || typeof line !== 'object' || Array.isArray(line))
        throw new Error(`“${field.label}”第 ${index + 1} 行无效。`)
      const entries = line as Record<string, unknown>
      const extra = Object.keys(entries).find(name => !names.has(name))
      if (extra) throw new Error(`“${field.label}”没有字段 ${extra}。`)
      // A line left entirely empty is one the person added and did not use; it is dropped, not sent.
      if (sub.every(item => isBlank(entries[item.name]))) continue
      const held: Record<string, CustomJson> = {}
      const shown: string[] = []
      for (const item of sub) {
        let value: { value: CustomJson; shown: string } | undefined
        try {
          value = fieldValue(item, entries[item.name], data)
        } catch (error) {
          throw new Error(`“${field.label}”第 ${lines.length + 1} 行：${error instanceof Error ? error.message : ''}`)
        }
        if (value) held[item.name] = value.value
        shown.push(value?.shown ?? '')
      }
      const figure = lineFigures(held, field.computed ?? [])
      lines.push(held)
      figures.push(figure)
      rows.push([...shown, ...(field.computed ?? []).map(item => figure[item.name] ?? '')])
    }
    if (lines.length < (field.min ?? 0)) throw new Error(`“${field.label}”至少要填 ${field.min} 行。`)
    if (field.required && !lines.length) throw new Error(`请填写“${field.label}”。`)
    linesByName.set(field.name, lines)
    figuresByName.set(field.name, figures)
    result.values[field.name] = lines
    result.lines.push({
      label: field.label,
      columns: [...sub.map(item => item.label), ...(field.computed ?? []).map(item => item.label)],
      rows,
    })
  }
  for (const item of form.computed ?? []) {
    const [group, column] = (item.sum ?? '.').split('.') as [string, string]
    let total = 0n
    for (const [index, line] of (linesByName.get(group) ?? []).entries()) {
      const figure = figuresByName.get(group)?.[index]?.[column] ?? line[column]
      if (typeof figure === 'string' && figure) total += decimal(figure)
    }
    result.computed.push({ label: item.label, value: decimalText(total) })
  }
  result.digest = createHash('sha256')
    .update(JSON.stringify({ form: form.name, row: rowPath, values: result.values }))
    .digest('hex')
  return result
}
