import { OryhClientError } from '@oryh/ai-client-foundation'
import { z } from 'zod'
import { blockIssues, blockQuestions, customBlockSchema, MAX_BLOCKS } from './custom-blocks.js'
import { type CustomForm, customFormSchema, formIssues } from './custom-forms.js'

const field = z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/)
const display = z
  .object({
    title: field.optional(),
    summary: field.optional(),
    date: field.optional(),
    columns: z
      .array(z.object({ field, label: z.string().trim().min(1).max(40) }).strict())
      .min(1)
      .max(40),
  })
  .strict()
export const customSourceSchema = z
  .object({
    collection: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .refine(value => value !== 'custom-pages'),
    filters: z.record(field, z.string().max(200)),
    display,
  })
  .strict()
/**
 * One field of a page's data contract. An `object` names its keys in `fields`; an `array` whose items are
 * objects names the keys of each item there. The template binds exactly these names.
 */
export interface ContractField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  required: boolean
  fields?: ContractField[] | undefined
}
/** A contract name is the page's own word, bound in its template; unlike an ORYH field it may be camelCase. */
const contractName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
const contractField: z.ZodType<ContractField> = z.lazy(() =>
  z
    .object({
      name: contractName,
      type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
      required: z.boolean(),
      fields: z.array(contractField).min(1).max(40).optional(),
    })
    .strict(),
)
function checkFields(fields: readonly ContractField[], ctx: z.RefinementCtx, path: (string | number)[], depth: number) {
  const names = fields.map(value => value.name)
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path, message: '字段重复' })
  for (const [index, value] of fields.entries()) {
    if (!value.fields) continue
    if (value.type !== 'object' && value.type !== 'array')
      ctx.addIssue({ code: 'custom', path: [...path, index], message: '只有 object 和 array 字段可以带 fields' })
    if (depth >= 3) ctx.addIssue({ code: 'custom', path: [...path, index], message: '数据约定最多嵌套 3 层' })
    checkFields(value.fields, ctx, [...path, index, 'fields'], depth + 1)
  }
}
export const customContractSchema = z
  .object({
    /**
     * A JSON Schema subset: each field's name, type and whether it is required; objects and arrays of
     * objects name their own fields. The runner validates the result against it before publication.
     */
    fields: z.array(contractField).min(1).max(80),
  })
  .strict()
  .superRefine((contract, ctx) => checkFields(contract.fields, ctx, ['fields'], 1))
export const customDefinitionSchema = z.preprocess(
  // A page saved while forms still wrote to ORYH themselves carries `actions`; those were never released,
  // and a page that has them loads without them rather than failing every write to its owner's pages.
  // A page that does not say how it is drawn is a `harness` page — unless it carries markup, which is a
  // page saved before there was a choice, and stays the `html` page it was.
  value => {
    if (!value || typeof value !== 'object') return value
    const { actions: _actions, ...rest } = value as Record<string, unknown>
    return rest.mode === undefined && rest.html !== undefined ? { ...rest, mode: 'html' } : rest
  },
  z
    .object({
      title: z.string().trim().min(1).max(24),
      /**
       * How the page is drawn (docs/53): `html`, the person's own markup in a sandboxed frame, or `harness`,
       * blocks drawn with DeepSeek Harness's components. Unsaid, it is `harness`.
       */
      mode: z.enum(['html', 'harness']).default('harness'),
      html: z.string().min(1).max(100_000).optional(),
      css: z.string().max(50_000).optional(),
      // Generated executable JavaScript is not admitted until a navigation-proof sandbox is verified.
      script: z.string().max(0).default(''),
      /** A `harness` page's blocks: data the client draws, each binding the page's data contract. */
      blocks: z.array(customBlockSchema).min(1).max(MAX_BLOCKS).optional(),
      fixedText: z.string().max(30_000).default(''),
      task: z
        .object({
          instruction: z.string().trim().min(10).max(20_000),
          /** Collections read before the run starts (docs/48 §17); the run may read anything else it needs. */
          sources: z.array(customSourceSchema).max(8).default([]),
          timeZone: z.string().min(1).max(80),
          contract: customContractSchema,
        })
        .strict(),
      /** What the person may fill in and hand to the Chat agent (docs/48 §16); none by default. */
      forms: z.array(customFormSchema).max(10).default([]),
    })
    .strict()
    .superRefine((definition, ctx) => {
      if (definition.mode === 'html') {
        if (definition.html === undefined)
          ctx.addIssue({ code: 'custom', path: ['html'], message: '完全自定义页面（mode: html）要有 html' })
        if (definition.blocks !== undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['blocks'],
            message: '完全自定义页面不能带 blocks；要用 Harness 组件，把 mode 设为 harness 并去掉 html、css',
          })
      } else {
        if (definition.html !== undefined || definition.css !== undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['html'],
            message: 'Harness 组件页面（mode: harness）不能带 html、css；要完全自定义，把 mode 设为 html',
          })
        if (definition.blocks === undefined)
          ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'Harness 组件页面要有 blocks' })
        else
          for (const issue of blockIssues(definition.blocks, definition.task.contract.fields, definition.forms))
            ctx.addIssue({ code: 'custom', path: ['blocks'], message: issue })
      }
      for (const issue of formIssues(definition.forms as CustomForm[], definition.task.contract.fields))
        ctx.addIssue({ code: 'custom', path: ['forms'], message: issue })
      if (new Set(definition.task.sources.map(s => s.collection)).size !== definition.task.sources.length)
        ctx.addIssue({ code: 'custom', path: ['task', 'sources'], message: '来源集合重复' })
      for (const [index, source] of definition.task.sources.entries())
        if (new Set(source.display.columns.map(column => column.field)).size !== source.display.columns.length)
          ctx.addIssue({ code: 'custom', path: ['task', 'sources', index, 'display'], message: '来源列重复' })
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: definition.task.timeZone })
      } catch {
        ctx.addIssue({ code: 'custom', path: ['task', 'timeZone'], message: '时区无效' })
      }
    }),
)
export type CustomDefinition = z.infer<typeof customDefinitionSchema>
/**
 * The questions a page may ask Chat about a row: declared in its HTML as `data-oryh-ask`, or on its blocks.
 * @param definition - the page's definition.
 * @returns the declared questions, as the page shows them.
 */
/**
 * What 「问 AI」 asks about a table row whose page declared no question of its own. Every table has it,
 * so a custom page need not have been written with Chat in mind to be asked about. The browser sends
 * these exact words (packages/client-analytics/src/client/harness-page.tsx); the Host takes no others
 * that the page did not declare.
 */
export const ROW_QUESTION_EN = 'Explain the current state of this row and anything I need to handle or watch.'
export const ROW_QUESTION = '请说明这一行现在的情况，并指出需要我处理或注意的地方。'

export function declaredQuestions(definition: CustomDefinition): string[] {
  if (definition.mode === 'harness') return blockQuestions(definition.blocks ?? [])
  return [...(definition.html ?? '').matchAll(/data-oryh-ask\s*=\s*(["'])([\s\S]*?)\1/g)].map(match =>
    match[2]!
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
      .trim(),
  )
}
/** A published value crosses the typed Remote to the browser, which admits JSON and nothing looser. */
export type CustomJson = null | boolean | number | string | CustomJson[] | { [key: string]: CustomJson }
export const customResultSchema = z.record(z.string(), z.unknown())
/**
 * One read a run made (docs/48 §17): a declared source, or a path the run's agent chose. `collection` is
 * the kind of record read, the path's first segment, which is what a later opening checks access to.
 */
export interface CustomRead {
  collection: string
  /** The dataset the run named it; a declared source's is its collection. */
  name?: string
  /** What was read, with its query: `/sales-orders/x/detail`, `/shipments?status=shipped`. */
  path?: string
  /** Whether it answered a list, read in full; a later check asks for one row of it. */
  list?: boolean
  total: number
  firstFetchedAt?: string
  fetchedAt: string
  ids: string[]
}
/** What a run is doing now, and how much it has read so far. */
export interface CustomRunProgress {
  /** The step, in words for the person. */
  step: string
  /** ORYH requests made so far. */
  requests: number
  /** Records read so far, over every dataset. */
  rows: number
}
export interface CustomRun {
  id: string
  version: number
  sessionId?: string
  status: 'running' | 'succeeded' | 'failed' | 'canceled'
  startedAt: string
  endedAt?: string
  error?: string
  /**
   * Where a run in progress has got to, for the page to show: a refresh is an agent reading ORYH again and
   * can take minutes, and a page that only said "refreshing" looked broken. Never stored: it is the live
   * run's, and gone with it.
   */
  progress?: CustomRunProgress
  data?: Record<string, CustomJson>
  sources?: CustomRead[]
  /** The grants the person held when this result was read (`grantsOf`); a result read under others is not shown. */
  grants?: string
  /**
   * The task this run carried out (`taskKey`). A result is shown for a later version only while that version's
   * task is the same one; a run stored before this was recorded has none.
   */
  task?: string
}
/** Where the last form submitted on a page stands: handed to the agent, or dealt with by it. */
export interface CustomSubmissionState {
  id: string
  form: string
  label: string
  status: 'sent' | 'done'
  at: string
}
export interface CustomPage {
  id: string
  version: number
  updatedAt: string
  /** The old analysis this page was migrated from (docs/48 §7), so a second migration skips it. */
  migratedFrom?: string
  /**
   * Set on a page a colleague shared (docs/58): this is the person's own copy of how it is made, kept in
   * step with the colleague's, with results the person read themselves. It is not theirs to change — a
   * copy made on purpose is — and it goes when the colleague withdraws it.
   */
  sharedFrom?: { author: string; updatedAt: string; changed?: boolean }
  definition: CustomDefinition
  previous?: { version: number; definition: CustomDefinition }
  latest?: CustomRun
  run?: CustomRun
  /** The page's last form submission; kept by the Host while it runs, never stored. */
  submission?: CustomSubmissionState
  /** Set when the stored result was withheld: it was read under grants the person no longer holds. */
  withheld?: 'grants'
}
export interface CustomPageSummary {
  id: string
  version: number
  title: string
  updatedAt: string
  available: boolean
  latest?: { version: number; status: CustomRun['status']; startedAt: string; endedAt?: string }
  run?: { status: CustomRun['status']; error?: string }
  hasPrevious: boolean
}
/** The result a page shows: its last one, while that was read for the page's current version. */
export function currentResult(page: CustomPage): CustomRun | undefined {
  const latest = page.latest
  return latest?.status === 'succeeded' && latest.version === page.version ? latest : undefined
}
export function customSummary(page: CustomPage): CustomPageSummary {
  return {
    id: page.id,
    version: page.version,
    title: page.definition.title,
    updatedAt: page.updatedAt,
    available: true,
    ...(page.latest
      ? {
          latest: {
            version: page.latest.version,
            status: page.latest.status,
            startedAt: page.latest.startedAt,
            ...(page.latest.endedAt ? { endedAt: page.latest.endedAt } : {}),
          },
        }
      : {}),
    ...(page.run ? { run: { status: page.run.status, ...(page.run.error ? { error: page.run.error } : {}) } } : {}),
    hasPrevious: Boolean(page.previous),
  }
}
export interface CustomRequest {
  sessionId: string
  connectionId: string
}
export interface CustomIdRequest extends CustomRequest {
  id: string
}
export interface CustomSaveRequest extends CustomRequest {
  id?: string
  expectedVersion?: number
  definition: CustomDefinition
}
export interface CustomRunRequest extends CustomIdRequest {
  expectedVersion: number
  /** Active UI/conversation language for persisted refresh labels and progress. */
  language?: string | undefined
}
/** One submission of a custom page's form: which form, on which row of the result, with what values. */
export interface CustomFormRequest extends CustomRunRequest {
  form: string
  /** The row the form belongs to, such as `rows.3`; empty for a form outside any repeated row. */
  row: string
  /** By field name: text as typed, a checkbox as a boolean, lines as a list of objects. */
  values: Record<string, CustomJson>
}
/** What the person is asked to confirm: what the agent will be asked to do, and with what. */
export interface CustomFormPreview {
  label: string
  instruction: string
  entries: { label: string; value: string }[]
  lines: { label: string; columns: string[]; rows: string[][] }[]
  computed: { label: string; value: string }[]
  digest: string
}
/** A confirmed submission: the preview's digest, so what the agent receives is what was shown. */
export interface CustomFormConfirm extends CustomFormRequest {
  digest: string
}
export interface CustomFormReceipt {
  submission: string
  message: string
}
/** A question a page asks Chat about one of its rows (`data-oryh-ask`). */
export interface CustomAskRequest extends CustomRunRequest {
  question: string
  row: string
}
/**
 * A form the person filled in in the conversation (chat-form.ts). The browser sends back the form as it
 * read it from the session — the tool call that showed it — and what was typed; both as JSON text, since
 * a form's shape is its own and the Remote's types carry none of it.
 */
export interface ChatFormSubmitRequest {
  sessionId: string
  /** Active Harness UI locale; also used for the composed user message. */
  language?: string
  /** The tool call that showed the form. */
  callId: string
  definitionJson: string
  valuesJson: string
}
export interface ChatFormReceipt {
  message: string
}
/** A search of an ORYH collection from a form's record field. */
export interface ChatFormRecordsRequest {
  sessionId: string
  /** Where the field looks: the collection, and the fields a record is named by. */
  collection: string
  label: string
  code?: string
  query: string
  page: number
}
export interface ChatFormRecords {
  rows: { id: string; code: string; name: string }[]
  total: number
  pages: number
}
/** What a migration of the old analyses did, one line per analysis. */
export interface CustomMigrationReport {
  migrated: { from: string; to: string; title: string; notes: string[] }[]
  existing: { from: string; to: string; title: string }[]
  failed: { from: string; title: string; error: string }[]
}

export function customFail(message: string): never {
  throw new OryhClientError(message, 'request-failed')
}
/** Whether a value has a contract field's type. JSON has no integers apart from numbers. */
function typed(value: unknown, type: ContractField['type']): boolean {
  if (value === null) return false
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value)
  return typeof value === type
}
function checkValue(fields: readonly ContractField[], value: Record<string, unknown>, path: string) {
  const names = new Set(fields.map(f => f.name))
  const extra = Object.keys(value).find(k => !names.has(k))
  if (extra) customFail(`结果字段 ${path}${extra} 不在数据约定中。`)
  for (const f of fields) {
    const v = value[f.name]
    if (v === undefined) {
      if (f.required) customFail(`结果缺少字段 ${path}${f.name}。`)
      continue
    }
    if (!typed(v, f.type)) customFail(`结果字段 ${path}${f.name} 应为 ${f.type}。`)
    if (!f.fields) continue
    if (f.type === 'object') checkValue(f.fields, v as Record<string, unknown>, `${path}${f.name}.`)
    else
      for (const [index, item] of (v as unknown[]).entries()) {
        if (!typed(item, 'object')) customFail(`结果字段 ${path}${f.name}[${index}] 应为对象。`)
        checkValue(f.fields, item as Record<string, unknown>, `${path}${f.name}[${index}].`)
      }
  }
}
export function validateResult(definition: CustomDefinition, value: unknown): Record<string, CustomJson> {
  const parsed = customResultSchema.safeParse(value)
  if (!parsed.success) customFail('结果必须是 JSON 对象。')
  const result = parsed.data
  checkValue(definition.task.contract.fields, result, '')
  if (JSON.stringify(result).length > 400_000) customFail('运行结果超过 400 KB。')
  // Parsed from the runner's JSON text, so every value is already JSON.
  return result as Record<string, CustomJson>
}
