/** Projects as a Harness Host plugin: the service, its Remote, and the tools over the new-project form. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { ProjectRecord } from '@oryh/ai-client-projects'
import { EncryptedRevisionStore } from '@oryh/ai-client-store'
import type {} from '@oryh/dsh-connection'
import type {} from '@oryh/dsh-pane'
import { ProjectChat } from './project-chat.js'
import { installProjectColumnsTool } from './project-columns.js'
import { ProjectsRemote } from './remote.js'

export { ProjectChat } from './project-chat.js'
export { configureProjectColumns, PROJECT_COLUMNS } from './project-columns.js'
export { ProjectsRemote } from './remote.js'

export const name = 'oryh-projects'
export const inject = ['typert', 'tools', 'oryhHost', 'oryhData', 'oryhPane']

export const PROJECT_RULES: readonly string[] = [
  '项目：中间栏正显示新建项目表单、而用户要你帮着填时，先用 oryh_project_read 读取，再调用 oryh_project_fill 填写；用户在对话里要求创建项目时按对应的 skill 直接完成。未知日期或客户先询问，不编造业务字段。',
]
export const PROJECT_TOOLS: readonly string[] = [
  'oryh_project_read',
  'oryh_project_fill',
  'oryh_open_project',
  'oryh_project_columns',
]

export function apply(ctx: Context): void {
  const data = ctx.oryhData
  const store = new EncryptedRevisionStore<ProjectRecord>(
    join(data.directory, 'projects'),
    data.storeKey?.('projects'),
    'ORYH AI Client Project Encryption',
  )
  const service = ctx.oryhHost.createProjectRemote(store)
  ctx.provide('oryhProjects', service)
  new ProjectChat(ctx, service, ctx.oryhPane).install()
  installProjectColumnsTool(ctx, ctx.oryhPane)
  ctx.effect(
    () =>
      ctx.oryhPane.contribute({
        name,
        resources: { projects: 'list-projects' },
        prompt: PROJECT_RULES,
        tools: PROJECT_TOOLS,
      }),
    'oryh projects contribution',
  )
  ctx.plugin(ProjectsRemote)
}
