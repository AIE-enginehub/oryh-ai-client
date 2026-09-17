/** Timesheets as a Harness Host plugin: the service, its Remote, and the tools over the form in the pane. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { EncryptedTimesheetStore } from '@oryh/ai-client-timesheets'
import type {} from '@oryh/dsh-connection'
import type {} from '@oryh/dsh-pane'
import { TimesheetsRemote } from './remote.js'
import { TimesheetChat } from './timesheet-chat.js'

export { TimesheetsRemote } from './remote.js'
export { TimesheetChat } from './timesheet-chat.js'

export const name = 'oryh-timesheets'
export const inject = ['typert', 'tools', 'oryhHost', 'oryhData', 'oryhWorkflows', 'oryhPane', 'oryhReview']

/** The rules the agent follows for timesheets; page names and tool names are its own. */
export const TIMESHEET_RULES: readonly string[] = [
  '中间栏未保存的工时表单是你读取或填写的，用户又让你在对话里按它新建、保存或提交时，写入成功后调用 oryh_open_timesheet 传服务端返回的 headerId 和 discardDraft=true，把中间栏换成服务端的单据；表单被用户改过时工具会拒绝，照实告诉用户。',
  '工时：用户要打开某人的已有工时时，先调用 oryh_find_timesheets 按姓名、日期或编号找候选，唯一时调用 oryh_open_timesheet 传 headerId 和对应 todoId，多个候选先询问，没有权限不尝试绕过；编辑权限以 detail.canEdit 为准。用户只要求打开工时表单时调用 oryh_open_timesheet（编号为空打开新建表单），不自行沿用聊天历史填写旧数据。',
  '中间栏正显示未保存的工时表单、而用户要你帮着填这张表单时，先用 oryh_timesheet_read 读取，再调用 oryh_timesheet_propose 填写，由用户在页面保存；其余情况（新建、修改、提交、审批工时）按工时 skill 在对话里直接完成。',
]
export const TIMESHEET_TOOLS: readonly string[] = [
  'oryh_timesheet_read',
  'oryh_timesheet_propose',
  'oryh_open_timesheet',
  'oryh_find_timesheets',
]

export function apply(ctx: Context): void {
  const data = ctx.oryhData
  const store = new EncryptedTimesheetStore(join(data.directory, 'timesheets'), data.storeKey?.('timesheets'))
  const service = ctx.oryhHost.createTimesheetRemote(store)
  // The page's disabled button is a hint; this is the gate. Every domain asks the same two questions
  // before a submit: does the tenant govern this object type, and did its review pass. Neither answer
  // is compiled in — the first is the server's, the second is the agent's.
  service.setWorkflowLookup((id, objectType) => ctx.oryhWorkflows.governed(id, objectType))
  service.setSubmitGate((objectType, documentId, sessionId) =>
    ctx.oryhReview.assertPassed(objectType, documentId, sessionId),
  )
  ctx.provide('oryhTimesheets', service)
  // Projects, work types and workflow rules are kept for a few minutes; what the agent wrote may have
  // changed them, so they are read again after a turn that wrote.
  ctx.effect(() => ctx.oryhPane.onServerChange(() => service.invalidate()), 'oryh timesheets reference data')
  const chat = new TimesheetChat(ctx, service, ctx.oryhPane, ctx.oryhReview)
  ctx.provide('oryhTimesheetChat', chat)
  chat.install()
  ctx.effect(
    () =>
      ctx.oryhPane.contribute({
        name,
        resources: { 'timesheet-headers': 'timesheets' },
        prompt: TIMESHEET_RULES,
        tools: TIMESHEET_TOOLS,
        // Open what the agent wrote (docs/36): the draft the agent filled is what it just wrote, so it
        // may give way; a draft the person changed since may not, and then the page keeps it and says so.
        open: async (sessionId, _resource, id) => {
          for (const discard of [true, false]) {
            try {
              await chat.openTimesheet(sessionId, AbortSignal.timeout(20_000), id, '', discard)
              return
            } catch {
              /* try without discarding, then give up */
            }
          }
        },
      }),
    'oryh timesheets contribution',
  )
  ctx.plugin(TimesheetsRemote)
}
