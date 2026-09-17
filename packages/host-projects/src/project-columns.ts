import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { requirePage } from '@oryh/ai-client-pages'
import { currentPage, type PaneService, textOutput } from '@oryh/dsh-pane'
import type { ProjectColumn } from './types.js'

const fail = (text: string) => new OryhClientError(text, 'request-failed')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const PROJECT_COLUMNS: readonly ProjectColumn[] = [
  'name',
  'code',
  'status',
  'client',
  'startDate',
  'endDate',
  'createdAt',
  'updatedAt',
]

/** Change which columns the project list shows: presentation only, acknowledged by the page. */
export async function configureProjectColumns(
  pane: PaneService,
  sessionId: string,
  columns: string[],
  signal: AbortSignal,
): Promise<string> {
  const page = currentPage(pane, sessionId)
  const { connection } = await pane.verified(sessionId)
  requirePage(connection.identity, page.page)
  if (page.page !== 'list-projects' || page.context?.key !== 'list-projects:list')
    throw fail('请先打开项目列表，退出当前详情或表单。')
  if (
    !columns.includes('name') ||
    columns.length > 8 ||
    new Set(columns).size !== columns.length ||
    columns.some(c => !PROJECT_COLUMNS.includes(c as ProjectColumn))
  )
    throw fail('列配置无效：只能选择项目支持的字段，必须保留项目名称。')
  return pane.issue<string>(
    sessionId,
    {
      lane: 'navigation',
      page: 'list-projects',
      payload: { target: 'columns', page: 'list-projects', columns },
      timeoutMs: 10_000,
    },
    id => ({
      invalid: () => {
        const now = pane.session(sessionId)
        return now?.page !== 'list-projects' || now.context?.key !== 'list-projects:list'
          ? '项目页面已变化，请重新读取。'
          : undefined
      },
      until: () =>
        pane.acked(sessionId, id) && same(pane.session(sessionId)?.context?.columns, columns)
          ? '项目列表显示列已更新，未修改业务记录。'
          : undefined,
      expired: '页面未确认列配置，请重新读取。',
      signal,
    }),
  )
}

export function installProjectColumnsTool(ctx: Context, pane: PaneService): void {
  ctx.tools.register(
    defineTool({
      name: 'oryh_project_columns',
      description: '调整项目列表显示列及顺序。传入完整列配置，必须保留 name；仅修改显示，不修改业务数据。',
      parameters: { columns: { type: 'array', required: true, items: { type: 'string', enum: [...PROJECT_COLUMNS] } } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要会话')
        return configureProjectColumns(pane, String(exec.agent.id), args.columns, exec.signal)
      },
    }),
  )
}
