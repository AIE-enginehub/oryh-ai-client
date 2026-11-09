import type { Context } from '@deepseek-ai/cordis'
import { RecordService } from '@oryh/ai-client-records'
import type {} from '@oryh/dsh-connection'
import { CHAT_FORM_TOOL } from './chat-form.js'
import { CUSTOM_RUNNER_TOOLS, CustomPageService } from './custom-service.js'
import { HarnessCustomPageStorage } from './custom-storage.js'
import { AnalyticsRemote } from './remote.js'
import { AnalysisService } from './service.js'
import { HarnessAnalysisStorage } from './storage.js'
import { installAnalyticsTools } from './tools.js'

export { AnalyticsRemote } from './remote.js'
export const name = 'oryh-analytics'

export const inject = [
  'typert',
  'tools',
  'oryhHost',
  'oryhPane',
  'oryhSharedViews',
  'storageDomain',
  'agents',
  'subagents',
  'systemPrompt',
  'agentDefaultModel',
  'workspaceRegistry',
]
export function apply(ctx: Context) {
  const records = RecordService.over(ctx.oryhHost.createDomainReads())
  const service = new AnalysisService(ctx.oryhPane, records, new HarnessAnalysisStorage(ctx))
  const custom = new CustomPageService(
    ctx,
    ctx.oryhPane,
    records,
    new HarnessCustomPageStorage(ctx),
    ctx.oryhHost.createPageReader(),
  )
  ctx.provide('oryhAnalytics', service)
  ctx.provide('oryhCustomPages', custom)
  ctx.effect(() => ctx.oryhPane.provideState(() => ({ customPages: custom.revisions() })), 'oryh custom page revisions')
  // A page is shared through the same door as a menu entry; how it is made is this plugin's to hand over.
  ctx.effect(
    () =>
      ctx.oryhSharedViews.providePages({
        definition: (sessionId, id) => custom.sharedMake(sessionId, id),
        copy: (sessionId, entry) => custom.copyShared(sessionId, entry),
      }),
    'oryh shared pages',
  )
  ctx.plugin(AnalyticsRemote)
  installAnalyticsTools(ctx, records, service, custom)
  ctx.effect(
    () =>
      ctx.oryhPane.contribute({
        name,
        tools: [
          CHAT_FORM_TOOL,
          'oryh_custom_page_catalog',
          'oryh_custom_page_list',
          'oryh_custom_page_get',
          'oryh_custom_page_save',
          'oryh_custom_page_run',
          'oryh_custom_page_open',
          'oryh_custom_page_restore',
          'oryh_custom_page_migrate',
          'oryh_custom_page_delete',
          'oryh_analysis_catalog',
          'oryh_analysis_list',
          'oryh_analysis_save',
          'oryh_analysis_update',
          'oryh_analysis_open',
          'oryh_analysis_section',
        ],
        // A page's data run reads, calculates and publishes, and can do nothing else; the Chat never sees these.
        runner: { tools: CUSTOM_RUNNER_TOOLS, owns: sessionId => custom.owns(sessionId) },
        prompt: [
          '对话里的表单：用户要录入、填报或登记有若干项内容的事（填工时、报销、下订单等）时，用 oryh_chat_form 在对话里出一张表单让他填，已知的内容预填。表单里凡是指向 ORYH 另一条记录的字段（客户、项目、产品、店铺、仓库、员工等）都必须是选择，不让用户手打名称或编号：候选少的先读出来放进 data 做下拉，其余用 record 字段让用户在弹出框里搜索；出表单后说一两句就结束这一轮，等用户提交。收到“我填好了「…」（表单编号 …）”的消息时，那是用户在表单上提交的内容，还没有写入：按其中的任务和写入前确认的规则办。录入不要做成自定义页面里的表单；自定义页面用来看数据。',
          '自定义页面：用户要求自定义页面、跨 ORYH 对象的统计或菜单时，先用 oryh_custom_page_catalog 读写法（给 collection 时还给出该集合的字段；两种写法怎么选、积木、HTML 绑定、表单和取数的写法以它为准，不要用 bash 去找技能或文档，也不要靠反复保存来试探格式），再用 oryh_custom_page_save 保存完整定义、oryh_custom_page_run 执行首次取数。页面数据由刷新 Agent 按 task.instruction 读取，可以读任意只读接口、多次组合，instruction 要写明读哪些接口、怎么关联、口径是什么。自定义页面不是 ORYH 资源，不要用 oryh_request 读它。定义里的 task 必须明确取数步骤、筛选、时区、口径和输出字段；重要业务口径不清楚先问。收到"在自定义页面上提交表单"的消息时，用户已填写表单并把内容交给你，但还没有在对话中确认业务写入：先在对话里列出将写入的记录和操作，等用户明确确认后再按其中的任务执行，完成后说明写了哪些记录（编号）。页面有两种写法：Harness 组件（mode: harness，写 blocks）和完全自定义（mode: html，HTML 用受控 data-oryh-field / template[data-oryh-each] 绑定，script 必须为空，不写可执行 JS）；用户指定了就照做，没指定时用 Harness 组件；积木做不到的地方告诉用户，用户要完全自定义才换，保存后告诉用户用了哪种。页面不直接请求 ORYH。后续修改先 custom_page_list 定位，再用 custom_page_get 读取完整定义及版本，按 expectedVersion 保存并保留未修改字段；打开页面不会刷新。只有 run 返回 displayed=true 才能声称页面已展示。',
          '图表和可编辑报告已支持！用户要求新建图表/报告时，先用 oryh_analysis_catalog，再用 oryh_analysis_save 创建并打开业务栏，不要用 Chat 字符图代替。只支持 catalog 来源，不把不支持来源静默换成其他对象。当前页面内容为事实，修改分析先读当前 definition/version，改标题、转报告、改正文必须优先用 oryh_analysis_update（自动保留其他设置）；分析参数错误只读 catalog 修正，不用 Bash 或文件系统查文档；手工未保存编辑不得覆盖。排序支持 label/value-desc/value-asc；Top N 用 topN 并配合 value-desc，仅记录数可合并其他，金额或产品数量禁止混合。报告 definition.sections 是实际章节顺序和正文，增删改移动用 analysis_section，稳定 id 定位且保留其余章节；summary/findings/nextSteps 是兼容字段。统计由受控取数计算，说明不得编造。返回 saved 只代表定义保存，displayed 才代表页面确认。定义不是业务单据，不需要业务审批。',
        ],
      }),
    'oryh analysis contribution',
  )
  // Sharing a page goes through the library; where the deployment keeps none, the agent is not told of it.
  ctx.inject(['oryhLibrary'], inner =>
    inner.effect(
      () =>
        ctx.oryhPane.contribute({
          name: `${name}-sharing`,
          prompt: [
            '共享自定义页面：用户要把自己的自定义页面共享给同事（或取消共享）时调用 oryh_menu_share，userViewId 用页面的 id；共享的是页面的做法，同事各自按自己的权限读数据、各自刷新，用户之后改页面，同事看到的也跟着变。userMenu 里带 sharedBy 的自定义页面是同事共享的，不能修改；用户想改就用 oryh_menu_copy 复制成他自己的页面再改。',
          ],
        }),
      'oryh analysis sharing contribution',
    ),
  )
}
