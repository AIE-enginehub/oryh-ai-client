/**
 * Filling a form a page describes.
 *
 * Nothing here knows what the form is. The page says what fields it has and what they hold; the agent
 * reads that with the page, and asks for some of them to be set. The Host checks the request against
 * the page's own description — a field it has, a choice it offers — and stages the values; the page
 * applies each one only where the person has not typed since, and reports which it took.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { PaneService } from './service.js'
import { textOutput } from './tools.js'
import type { FormColumnSpec, FormFieldSpec, FormLine, FormScalar, FormValue, PaneFormContext } from './types.js'

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/** The tools, named for the agent's allow-list. */
export const FORM_TOOLS: readonly string[] = ['oryh_form_fill']

/** The standing rule that goes with them. */
export const FORM_RULE =
  '当前页面上下文（oryh-current-page）里的 forms，是页面上可以代填的表单：每个表单有 id、名称、字段（name、label、type，select 类型带 options）和当前的值。用户让你帮着填、或你已经知道该填什么时，调用 oryh_form_fill 按字段的 name 填写，select 用 options 里的 value，checkbox 用 true/false，日期写 YYYY-MM-DD。type 为 lines 的字段是明细行：值是一个列表，每行是“列 name: 值”的对象（列见 columns），传的是整张列表，会替换表单上现有的行，要保留的行也一起传。它只改页面上未保存的表单，不保存、不提交；提交仍是页面上的按钮。返回的 applied 是填上了的字段；kept 是用户在你读到之后自己改过、因此保留原样没有覆盖的字段，照实告诉用户，不要重试去覆盖。'

/** What a staged value is when it is not one: a sentence saying what is wrong with it. */
export interface FormProblem {
  problem: string
}
const isProblem = (value: FormValue | FormProblem): value is FormProblem =>
  typeof value === 'object' && !Array.isArray(value)
/** A real day of the calendar, written `YYYY-MM-DD`: February has no 30th. */
const isDay = (text: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) &&
  Number.isFinite(Date.parse(text)) &&
  new Date(text).toISOString().slice(0, 10) === text

/** What one value has to be for a field that holds text or a tick. */
function scalarValue(field: FormColumnSpec, value: unknown): FormScalar | FormProblem {
  const called = `${field.label}（${field.name}）`
  if (field.type === 'checkbox') return typeof value === 'boolean' ? value : { problem: `${called}要填 true 或 false` }
  if (typeof value !== 'string' && typeof value !== 'number') return { problem: `${called}要填文本` }
  const text = String(value)
  const limit = field.maxLength ?? 4000
  if (text.length > limit) return { problem: `${called}最多 ${limit} 个字` }
  if (field.type === 'select' && text !== '' && field.options && !field.options.some(option => option.value === text))
    return {
      problem: `${called}只能是：${field.options.map(option => `${option.value}（${option.label}）`).join('、')}`,
    }
  if (field.type === 'date' && text !== '' && !isDay(text))
    return { problem: `${called}要写成 YYYY-MM-DD，且是真实的日期` }
  if (field.type === 'number' && text !== '' && !Number.isFinite(Number(text.replaceAll(',', ''))))
    return { problem: `${called}要填数字` }
  return text
}

/** What a form's lines have to be: its rows in full, each holding only the columns the form has. */
function linesValue(field: FormFieldSpec, value: unknown): FormLine[] | FormProblem {
  const called = `${field.label}（${field.name}）`
  const columns = field.columns ?? []
  if (!Array.isArray(value)) return { problem: `${called}是明细行，要填一个列表，每行是“列名: 值”的对象` }
  if (value.length > (field.max ?? 50)) return { problem: `${called}最多 ${field.max ?? 50} 行` }
  if (value.length < (field.min ?? 0)) return { problem: `${called}至少 ${field.min} 行` }
  const rows: FormLine[] = []
  for (const [index, row] of value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      return { problem: `${called}第 ${index + 1} 行要是“列名: 值”的对象` }
    // A column the agent leaves out is empty on that row, as it is on a row the person adds.
    const line: FormLine = Object.fromEntries(
      columns.map(column => [column.name, column.type === 'checkbox' ? false : '']),
    )
    for (const [name, cell] of Object.entries(row as Record<string, unknown>)) {
      const column = columns.find(candidate => candidate.name === name)
      if (!column) return { problem: `${called}的行里没有列 ${name}，可用的列：${columns.map(c => c.name).join('、')}` }
      const checked = scalarValue(column, cell)
      if (isProblem(checked)) return { problem: `${called}第 ${index + 1} 行：${checked.problem}` }
      line[name] = checked
    }
    rows.push(line)
  }
  return rows
}

/**
 * What a value has to be for a field, or why it cannot be.
 * @returns the value to stage, or a sentence saying what is wrong with it.
 */
export function fieldValue(form: PaneFormContext, name: string, value: unknown): FormValue | FormProblem {
  const field = form.fields.find(candidate => candidate.name === name)
  if (!field) return { problem: `没有字段 ${name}` }
  return field.type === 'lines' ? linesValue(field, value) : scalarValue({ ...field, type: field.type }, value)
}

/**
 * Fill some fields of a form on the page, and wait for the page to say which it took.
 * @param formId - the form's id as the page reports it; may be omitted when the page shows one form.
 * @param values - field name to value.
 */
export async function fillForm(
  pane: PaneService,
  sessionId: string,
  formId: string | undefined,
  values: unknown,
  signal: AbortSignal,
): Promise<{ form: string; applied: string[]; kept: string[]; values: Record<string, FormValue>; notice: string }> {
  const session = pane.page(sessionId)
  const forms = session.context?.forms ?? []
  if (forms.length === 0) {
    const closed = session.context?.closedForms ?? []
    throw fail(
      closed.length > 0
        ? `这个页面有表单（${closed.join('、')}），但现在不在页面上：它在记录行的按钮后面，点开哪一行，那一行的表单才出现。请用户先在页面上点开要填的那一行，再让你填；不要说这个页面不能代填。`
        : '当前页面没有可以代填的表单。',
    )
  }
  const form = formId ? forms.find(candidate => candidate.id === formId) : forms.length === 1 ? forms[0] : undefined
  if (!form)
    throw fail(
      `请用 form 指明填哪个表单：${forms.map(candidate => `${candidate.id}（${candidate.label}）`).join('、')}。`,
    )
  if (form.busy) throw fail(`“${form.label}”正在提交或等待确认，现在不能填写。`)
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('values 要是“字段名: 值”的对象。')
  const staged: Record<string, FormValue> = {}
  const problems: string[] = []
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    const checked = fieldValue(form, name, value)
    if (isProblem(checked)) problems.push(checked.problem)
    else staged[name] = checked
  }
  if (problems.length) throw fail(`没有填写：${problems.join('；')}。`)
  if (Object.keys(staged).length === 0) throw fail('没有要填写的字段。')
  // What the page's own rules make of the form as it would then stand: an end before its start, say.
  const unfit = pane.formProblem(session.page, form, { ...form.values, ...staged })
  if (unfit) throw fail(`没有填写：${unfit}`)
  // What the agent read is what the Host holds of the form now; the page compares it again as the fill lands.
  const base = Object.fromEntries(
    Object.keys(staged).map(name => [name, form.values[name] ?? (Array.isArray(staged[name]) ? [] : '')]),
  )
  return pane.issue(
    sessionId,
    {
      lane: 'form',
      page: session.page,
      payload: { kind: 'fields', revision: session.revision, form: form.id, base, values: staged },
      timeoutMs: 10_000,
    },
    command => ({
      until: () => {
        if (!pane.acked(sessionId, command)) return undefined
        const now = pane.session(sessionId)?.context?.forms?.find(candidate => candidate.id === form.id)
        if (now?.chat?.id !== command) return undefined
        const { applied, kept } = now.chat
        return {
          form: form.id,
          applied,
          kept,
          values: now.values,
          notice:
            (kept.length ? `${kept.join('、')} 是用户在这之后自己改过的，保留了他填的内容，没有覆盖。` : '都已填上。') +
            '表单还没有保存或提交，那是页面上的按钮。',
        }
      },
      expired: '页面没有确认这次填写，请重新读取当前页面。',
      signal,
    }),
  )
}

/** Register the form tool every page shares. */
export function installFormTools(ctx: Context, pane: PaneService): void {
  ctx.tools.register(
    defineTool({
      name: 'oryh_form_fill',
      description:
        '填写当前页面上的表单（oryh-current-page 上下文里 forms 中的一个）。只改页面上未保存的表单，不保存也不提交。values 是“字段 name: 值”，明细行（type 为 lines）传整张列表；用户自己改过的字段不会被覆盖，会在返回的 kept 里列出。',
      parameters: {
        form: { type: 'string', description: '表单的 id；页面上只有一个表单时可以不传' },
        values: {
          type: 'object',
          required: true,
          additionalProperties: true,
          description:
            '要填的字段，例如 {"reason":"客户要求改期","new_date":"2026-10-12"}；明细行如 {"items":[{"product":"P-01","qty":"2"}]}',
        },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        const form = typeof args.form === 'string' && args.form ? args.form : undefined
        return JSON.stringify(await fillForm(pane, String(exec.agent.id), form, args.values, exec.signal))
      },
    }),
  )
}
