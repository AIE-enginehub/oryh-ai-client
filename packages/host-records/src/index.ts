/** Record lists as a Harness Host plugin: the read service, its Remote, and the list tools in the pane. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { RecordService } from '@oryh/ai-client-records'
import type {} from '@oryh/dsh-connection'
import type {} from '@oryh/dsh-pane'
import { ListTools } from './list-tools.js'
import { RecordsRemote } from './remote.js'

export { ListTools } from './list-tools.js'
export { RecordsRemote } from './remote.js'

export const name = 'oryh-records'
export const inject = ['typert', 'tools', 'oryhHost', 'oryhPane', 'oryhSharedViews']

export const RECORD_RULES: readonly string[] = [
  '显示列：先用 oryh_current_page 查看 columns 和 availableColumns；菜单里的销售订单、库存余额、库存流水和收发货列表用 oryh_record_columns，传完整列顺序并保留其他列。只改显示，不需要确认；不支持的字段不得伪造。',
  '查询栏：用户要求在列表查询栏增加或填写查询字段时调用 oryh_record_query，不要误用显示列工具；查询字段只能是该列表在 ORYH 接口里声明的查询参数，不在其中就如实说明 ORYH 目前不支持按该字段查询，不要编造页面上的替代办法。库存流水的产品查询按编码精确匹配，不能凭历史记录猜编码；仅增加字段时不填写值。',
  '页面上的列表只陈述当前页的数据与服务端总量，不把当前页当全部记录；需要全部记录时按 skill 查询服务端。',
  '菜单项：用户要求新增菜单项时（如“加一个菜单叫订单项，列出所有订单项”“加一个菜单叫入库单，列出入库的收发货”），菜单可以显示 ORYH 的任何一个集合。不确定集合名时先用 ORYH 的 builtin_object_types 工具查（订单项是 sales-order-items），再用 oryh_record_filter_fields 看可筛选字段和行字段，然后调用 oryh_menu_add，并按用户和这家公司的说法给出 columns 的中文列名——接口里只有英文字段名，这一步只能由你来做。字段取值以 ORYH 的 skill 或接口说明为准，不猜。该接口没声明返回结构时，先用 oryh_list 读一页数据看看有哪些字段再定列。用户要的列有显示不了的，或者还有要他决定的事，先问清楚再调用 oryh_menu_add，不要先建好再问；也不要不说就少建一列。用户说打开自己加的菜单项时调用 oryh_open_view；oryh_current_page 返回的 userMenu 就是这些菜单项。',
]
/** Offered only where the deployment keeps a library colleagues share through; the desktop has none. */
export const SHARE_RULES: readonly string[] = [
  '共享菜单项：userMenu 里带 sharedBy 的是同事共享的，可以打开，不能改也不能删；用户想改就用 oryh_menu_copy 复制一份成他自己的再改。用户明确说要把自己的某个菜单项共享给同事（或取消共享）时调用 oryh_menu_share；共享的只是菜单的做法，不是数据，同事各自按自己的权限读。',
]
export const SHARE_TOOLS: readonly string[] = ['oryh_menu_share', 'oryh_menu_copy']
export const RECORD_TOOLS: readonly string[] = [
  'oryh_record_filter_fields',
  'oryh_menu_add',
  'oryh_menu_remove',
  'oryh_open_view',
  'oryh_record_columns',
  'oryh_record_query',
  'oryh_search_products',
]

export function apply(ctx: Context): void {
  const service = RecordService.over(ctx.oryhHost.createDomainReads())
  ctx.provide('oryhRecords', service)
  new ListTools(ctx, ctx.oryhPane, service).install()
  ctx.effect(
    () =>
      ctx.oryhPane.contribute({
        name,
        // No `resources`: the four record lists are no pages of their own (docs/57), so a read is not
        // followed to one and a record is not opened on one. They still draw the lists a person had made over those collections.
        prompt: RECORD_RULES,
        tools: RECORD_TOOLS,
      }),
    'oryh records contribution',
  )
  // Offered while there is a library: told of sharing where there is none, the agent proposed it, had the
  // person confirm, and only then learned it could not.
  ctx.inject(['oryhLibrary'], inner =>
    inner.effect(
      () => ctx.oryhPane.contribute({ name: `${name}-sharing`, prompt: SHARE_RULES, tools: SHARE_TOOLS }),
      'oryh records sharing contribution',
    ),
  )
  ctx.plugin(RecordsRemote)
}
