/** Record lists as a Harness Host plugin: the read service, its Remote, and the list tools in the pane. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@oryh/dsh-connection'
import type {} from '@oryh/dsh-pane'
import { ListTools } from './list-tools.js'
import { RecordsRemote } from './remote.js'

export { ListTools } from './list-tools.js'
export { RecordsRemote } from './remote.js'

export const name = 'oryh-records'
export const inject = ['typert', 'tools', 'oryhHost', 'oryhPane']

export const RECORD_RULES: readonly string[] = [
  '显示列：先用 oryh_current_page 查看 columns 和 availableColumns；销售订单、库存余额、库存流水和收发货列表用 oryh_record_columns，项目列表用 oryh_project_columns，传完整列顺序并保留其他列；项目名称 name 必须保留，createdAt 是创建时间，updatedAt 是更新时间。只改显示，不需要确认；不支持的字段不得伪造。',
  '查询栏：用户要求在列表查询栏增加或填写查询字段时调用 oryh_record_query，不要误用显示列工具；查询字段只能是该列表在 ORYH 接口里声明的查询参数，不在其中就如实说明 ORYH 目前不支持按该字段查询，不要编造页面上的替代办法。库存流水的产品查询按编码精确匹配，不能凭历史记录猜编码；仅增加字段时不填写值。',
  '页面上的列表只陈述当前页的数据与服务端总量，不把当前页当全部记录；需要全部记录时按 skill 查询服务端。',
  '菜单项：用户要求新增菜单项（如“加一个菜单叫入库单，列出入库的收发货”）时，先用 oryh_record_filter_fields 查该列表可用的筛选字段，再调用 oryh_menu_add；字段取值以 ORYH 的 skill 或接口说明为准，不猜。用户说打开自己加的菜单项时调用 oryh_open_view；oryh_current_page 返回的 userMenu 就是这些菜单项。',
]
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
  const service = ctx.oryhHost.createRecordRemote()
  ctx.provide('oryhRecords', service)
  new ListTools(ctx, ctx.oryhPane, service).install()
  ctx.effect(
    () =>
      ctx.oryhPane.contribute({
        name,
        resources: {
          'sales-orders': 'sales-orders',
          'inventory-items': 'inventory-items',
          'inventory-item-details': 'inventory-item-details',
          shipments: 'shipments',
        },
        prompt: RECORD_RULES,
        tools: RECORD_TOOLS,
      }),
    'oryh records contribution',
  )
  ctx.plugin(RecordsRemote)
}
