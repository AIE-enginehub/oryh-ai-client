import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { type OryhProjectRemote, validateProject } from '@oryh/ai-client-projects'
import { type PaneService, type PaneSession, textOutput } from '@oryh/dsh-pane'
import type { ProjectPaneContext } from '@oryh/dsh-pane/types'
import { z } from 'zod'

const schema = z
  .object({
    project_name: z.string().max(200),
    project_code: z.string().max(64),
    client: z.string().max(200),
    start_date: z.string(),
    end_date: z.string(),
  })
  .strict()
const fail = (text: string) => new OryhClientError(text, 'request-failed')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The new-project form in the business pane, for the agent: opening it, reading it and filling it.
 * Creating the project is the person's click, or the agent's own write through a skill; never a tool here.
 */
export class ProjectChat {
  constructor(
    private readonly ctx: Context,
    private readonly api: OryhProjectRemote | undefined,
    private readonly pane: PaneService,
  ) {}

  /** The form section of the pane, when the project page is showing. */
  current(sessionId: string): ProjectPaneContext | undefined {
    const session = this.pane.session(sessionId)
    return session?.page === 'list-projects' ? session.context?.project : undefined
  }

  private form(sessionId: string): { session: PaneSession; form: ProjectPaneContext; api: OryhProjectRemote } {
    const session = this.pane.session(sessionId)
    if (!session) throw fail('请先连接企业。')
    if (session.page !== 'list-projects') throw fail('当前不是项目页面。')
    const form = session.context?.project
    if (!form || !this.api) throw fail('新建项目表单尚未打开。')
    return { session, form, api: this.api }
  }

  async read(sessionId: string) {
    const { session, form, api } = this.form(sessionId)
    const options = await api.projectOptions(session.connectionId)
    this.pane.assertUnchanged(sessionId, session, '表单已变化，请重新读取。')
    return {
      revision: session.revision,
      fields: form.fields,
      busy: form.busy,
      options,
      notice: '这是未保存表单，项目尚未创建。',
    }
  }

  async fill(sessionId: string, revision: number, input: unknown, signal: AbortSignal): Promise<string> {
    const { session, form } = this.form(sessionId)
    if (session.revision !== revision || form.busy) throw fail('表单版本已改变或正在核对，请重新读取。')
    const parsed = schema.safeParse(input)
    if (!parsed.success) throw fail('项目字段格式无效。')
    const fields = parsed.data
    validateProject(fields, false)
    if (same(fields, form.fields)) return '当前表单已是这些内容，未创建项目。'
    return this.pane.issue<string>(
      sessionId,
      { lane: 'form', page: 'list-projects', payload: { kind: 'project', revision, fields }, timeoutMs: 10_000 },
      id => ({
        invalid: () => {
          const now = this.pane.session(sessionId)
          if (now?.page !== 'list-projects' || !now.context?.project) return '项目页面已关闭。'
          // The person typed something else before the page applied the fill: theirs wins.
          return now.revision > revision && !this.pane.acked(sessionId, id) && !same(now.context.project.fields, fields)
            ? '用户已修改表单，请重新读取。'
            : undefined
        },
        until: () =>
          this.pane.acked(sessionId, id) && same(this.pane.session(sessionId)?.context?.project?.fields, fields)
            ? '中间栏新建项目表单已更新，尚未创建项目。'
            : undefined,
        expired: '填写未获页面确认，请重新读取。',
        signal,
      }),
    )
  }

  /** Open the blank create form in the pane, for the person to fill or the agent to help with. */
  async openProject(sessionId: string, signal: AbortSignal): Promise<string> {
    if (!this.api) throw fail('请先连接企业。')
    const { session } = await this.pane.verified(sessionId)
    if (!(await this.api.projectOptions(session.connectionId)).canCreate)
      throw fail('当前账号没有创建项目的主数据管理权限。')
    if (this.pane.session(sessionId)?.scope !== session.scope) throw fail('企业页面已改变。')
    return this.pane.issue<string>(
      sessionId,
      {
        lane: 'navigation',
        page: 'list-projects',
        payload: { target: 'project', page: 'list-projects' },
        timeoutMs: 15_000,
      },
      id => ({
        invalid: () => (this.pane.session(sessionId)?.scope !== session.scope ? '页面已改变。' : undefined),
        until: () =>
          this.pane.acked(sessionId, id) && this.current(sessionId) !== undefined
            ? '新建项目表单已打开，未保存内容保留。请先读取字段再填写；尚未创建项目。'
            : undefined,
        expired: '项目表单未能打开，请核对页面状态后重试。',
        signal,
      }),
    )
  }

  install(): void {
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_project_read',
        description: '读取新建项目表单、版本和实际创建权限。仅返回未保存字段，不返回确认凭据。',
        parameters: {},
        output: textOutput,
        execute: async (_args, exec) => {
          if (!exec.agent) throw fail('需要会话')
          return JSON.stringify(await this.read(String(exec.agent.id)))
        },
      }),
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_project_fill',
        description:
          '帮用户填写中间栏上未保存的新建项目表单；完整字段中未要求修改的内容保持不变。不会创建项目；在对话里直接创建项目请按对应的 skill 执行。日期用 YYYY-MM-DD，空字段用空字符串。',
        parameters: {
          revision: { type: 'integer', required: true },
          fields: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              project_name: { type: 'string', required: true },
              project_code: { type: 'string', required: true },
              client: { type: 'string', required: true },
              start_date: { type: 'string', required: true },
              end_date: { type: 'string', required: true },
            },
          },
        },
        output: textOutput,
        execute: async (args, exec) => {
          if (!exec.agent) throw fail('需要会话')
          return this.fill(String(exec.agent.id), args.revision, args.fields, exec.signal)
        },
      }),
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_open_project',
        description:
          '在中间栏打开新建项目表单，供用户在页面上填写。检查真实权限并保留已有未保存内容，不创建项目。之后读取表单再帮着填写；在对话里直接创建项目请按对应的 skill 执行。',
        parameters: {},
        output: textOutput,
        execute: async (_args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          return this.openProject(String(exec.agent.id), exec.signal)
        },
      }),
    )
  }
}
