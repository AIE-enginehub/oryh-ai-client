/**
 * The Harness-component way of writing a custom page (docs/53). Instead of HTML in a sandboxed frame, the
 * page is a list of blocks: plain data the model writes, drawn by the client with DeepSeek Harness's UI
 * components and the table, chart and form pieces built on them. Nothing on such a page is markup or code
 * the model wrote, so it needs no frame; what it binds is held to the page's data contract when it is saved.
 */
import { z } from 'zod'
import type { CustomForm } from './custom-forms.js'
import type { ContractField } from './custom-model.js'

export type CustomFormat = 'number' | 'money' | 'percent' | 'date'
/** A value a block shows: the contract field, what it is called on the page, and how it is written. */
export interface CustomBoundField {
  field: string
  label: string
  format?: CustomFormat | undefined
}
/** A question a row asks Chat, as the page names it on its button. */
export interface CustomAsk {
  label: string
  question: string
}
export type CustomBlock =
  | { type: 'markdown'; text: string }
  | { type: 'fixed' }
  | { type: 'metrics'; items: CustomBoundField[] }
  | {
      type: 'table'
      data: string
      columns: CustomBoundField[]
      sortable?: boolean | undefined
      pageSize?: number | undefined
      open?: string | undefined
      ask?: CustomAsk[] | undefined
      form?: string | undefined
    }
  | {
      type: 'list'
      data: string
      title: string
      summary?: string | undefined
      meta?: CustomBoundField[] | undefined
      open?: string | undefined
      ask?: CustomAsk[] | undefined
      form?: string | undefined
    }
  | {
      type: 'chart'
      kind: 'bar' | 'line' | 'pie'
      data: string
      label: string
      value: string
      title?: string | undefined
    }
  | {
      type: 'filter'
      targets: string[]
      field?: string | undefined
      label: string
      control: 'text' | 'select' | 'pills'
    }
  | { type: 'tabs'; tabs: { label: string; blocks: CustomBlock[] }[] }
  | {
      type: 'section'
      title: string
      collapsible?: boolean | undefined
      collapsed?: boolean | undefined
      blocks: CustomBlock[]
    }
  | { type: 'form'; name: string }

const NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
const FORMAT = z.enum(['number', 'money', 'percent', 'date'])
const label = (max: number) => z.string().trim().min(1).max(max)
const bound = z.object({ field: NAME, label: label(40), format: FORMAT.optional() }).strict()
const ask = z.object({ label: label(24), question: label(200) }).strict()
/** `object_type:field`, as the HTML way's `data-oryh-open`. */
const OPEN = z.string().regex(/^[a-z][a-z0-9_]{0,63}:[A-Za-z_][A-Za-z0-9_]{0,63}$/)
const FORM = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/)
const nested = z
  .array(z.lazy(() => customBlockSchema))
  .min(1)
  .max(40)

export const customBlockSchema: z.ZodType<CustomBlock> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('markdown'), text: z.string().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal('fixed') }).strict(),
  z.object({ type: z.literal('metrics'), items: z.array(bound).min(1).max(12) }).strict(),
  z
    .object({
      type: z.literal('table'),
      data: NAME,
      columns: z.array(bound).min(1).max(20),
      sortable: z.boolean().optional(),
      pageSize: z.number().int().min(5).max(200).optional(),
      open: OPEN.optional(),
      ask: z.array(ask).max(5).optional(),
      form: FORM.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('list'),
      data: NAME,
      title: NAME,
      summary: NAME.optional(),
      meta: z.array(bound).max(8).optional(),
      open: OPEN.optional(),
      ask: z.array(ask).max(5).optional(),
      form: FORM.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('chart'),
      kind: z.enum(['bar', 'line', 'pie']),
      data: NAME,
      label: NAME,
      value: NAME,
      title: label(60).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('filter'),
      targets: z.array(NAME).min(1).max(5),
      field: NAME.optional(),
      label: label(24),
      control: z.enum(['text', 'select', 'pills']),
    })
    .strict(),
  z
    .object({
      type: z.literal('tabs'),
      tabs: z
        .array(z.object({ label: label(24), blocks: nested }).strict())
        .min(2)
        .max(8),
    })
    .strict(),
  z
    .object({
      type: z.literal('section'),
      title: label(60),
      collapsible: z.boolean().optional(),
      collapsed: z.boolean().optional(),
      blocks: nested,
    })
    .strict(),
  z.object({ type: z.literal('form'), name: FORM }).strict(),
]) as unknown as z.ZodType<CustomBlock>

/** `{{field}}` or `{{field|money}}` in a markdown block: a top-level value, written as text. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*(?:\|\s*([a-z]+)\s*)?\}\}/g
export const MAX_BLOCKS = 80
export const MAX_DEPTH = 3

/**
 * What a page's blocks bind that its contract or forms do not have, one message per problem, each naming
 * the block by its path (`blocks[2].tabs[0].blocks[1]`) so the agent can fix exactly that.
 * @param blocks - the page's blocks.
 * @param contract - the fields of the page's data contract.
 * @param forms - the page's declared forms.
 * @returns the problems; none when every binding holds.
 */
export function blockIssues(
  blocks: readonly CustomBlock[],
  contract: readonly ContractField[],
  forms: readonly Pick<CustomForm, 'name'>[],
): string[] {
  const issues: string[] = []
  const top = new Map(contract.map(field => [field.name, field]))
  const formNames = new Set(forms.map(form => form.name))
  let count = 0
  /** The fields of each item of a top-level array of objects, or why there are none. */
  const itemsOf = (name: string): Map<string, ContractField> | string => {
    const field = top.get(name)
    if (!field) return `${name} 不在数据约定里`
    if (field.type !== 'array' || !field.fields) return `${name} 不是数据约定里列出了字段的对象数组`
    return new Map(field.fields.map(item => [item.name, item]))
  }
  const scalar = (name: string): string | undefined => {
    const field = top.get(name)
    if (!field) return `${name} 不在数据约定里`
    if (field.type === 'array' || field.type === 'object') return `${name} 是 ${field.type}，这里只能放单个值`
    return undefined
  }
  const walk = (list: readonly CustomBlock[], path: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      issues.push(`${path}：积木最多嵌套 ${MAX_DEPTH} 层`)
      return
    }
    for (const [index, block] of list.entries()) {
      count++
      const at = `${path}[${index}]（${block.type}）`
      const problem = (message: string) => issues.push(`${at}：${message}`)
      const rowFields = (data: string, names: readonly (string | undefined)[], what: string) => {
        const items = itemsOf(data)
        if (typeof items === 'string') return problem(`data=${items}`)
        for (const name of names)
          if (name !== undefined && !items.has(name)) problem(`${what} ${name} 不是 ${data} 每一项的字段`)
        return items
      }
      const rowActions = (data: string, open?: string, form?: string) => {
        if (open) rowFields(data, [open.split(':')[1]], 'open 的字段')
        if (form && !formNames.has(form)) problem(`form=${form} 不在 definition.forms 里`)
      }
      switch (block.type) {
        case 'markdown':
          for (const match of block.text.matchAll(PLACEHOLDER)) {
            const reason = scalar(match[1]!)
            if (reason) problem(`{{${match[1]}}}：${reason}`)
            if (match[2] && !['number', 'money', 'percent', 'date'].includes(match[2]))
              problem(`{{${match[1]}|${match[2]}}}：格式只能是 number、money、percent、date`)
          }
          break
        case 'metrics':
          for (const item of block.items) {
            const reason = scalar(item.field)
            if (reason) problem(reason)
          }
          break
        case 'table':
          rowFields(
            block.data,
            block.columns.map(column => column.field),
            '列',
          )
          rowActions(block.data, block.open, block.form)
          break
        case 'list':
          rowFields(block.data, [block.title, block.summary, ...(block.meta ?? []).map(item => item.field)], '字段')
          rowActions(block.data, block.open, block.form)
          break
        case 'chart':
          rowFields(block.data, [block.label, block.value], '字段')
          break
        case 'filter':
          // A select or a row of pills lists the values of one field; a text box may match any.
          if (block.control !== 'text' && block.field === undefined) problem(`control=${block.control} 要写 field`)
          for (const target of block.targets) rowFields(target, [block.field], '筛选字段')
          break
        case 'tabs':
          for (const [tab, { blocks: inner }] of block.tabs.entries())
            walk(inner, `${at}.tabs[${tab}].blocks`, depth + 1)
          break
        case 'section':
          walk(block.blocks, `${at}.blocks`, depth + 1)
          break
        case 'form':
          if (!formNames.has(block.name)) problem(`${block.name} 不在 definition.forms 里`)
          break
        case 'fixed':
          break
      }
    }
  }
  walk(blocks, 'blocks', 1)
  if (count > MAX_BLOCKS) issues.push(`积木一共 ${count} 块，最多 ${MAX_BLOCKS} 块`)
  return issues
}

/**
 * Every question a page's rows may ask Chat, which is what an ask from the page is held to.
 * @param blocks - the page's blocks.
 * @returns the declared questions.
 */
export function blockQuestions(blocks: readonly CustomBlock[]): string[] {
  return blocks.flatMap(block => {
    if (block.type === 'table' || block.type === 'list') return (block.ask ?? []).map(item => item.question)
    if (block.type === 'tabs') return block.tabs.flatMap(tab => blockQuestions(tab.blocks))
    if (block.type === 'section') return blockQuestions(block.blocks)
    return []
  })
}
