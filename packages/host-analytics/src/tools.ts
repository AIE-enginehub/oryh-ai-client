/**
 * The tools the agent is given for custom pages, analyses and the Chat form: their names, parameters and
 * what each one does. They are registered apart from the plugin's wiring so the page service and its data
 * run stay readable; everything here goes through those services.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { canAccessPage } from '@oryh/ai-client-pages'
import { type OryhRecordRemote, recordColumns } from '@oryh/ai-client-records'
import { currentPage, reveal, SHOW_PARAMETER, textOutput } from '@oryh/dsh-pane'
import { CHAT_FORM_SHOWN, CHAT_FORM_TOOL, parseChatForm } from './chat-form.js'
import type { CalculationRequest } from './custom-calculation.js'
import { type CustomPage, currentResult, customDefinitionSchema, customFail } from './custom-model.js'
import type { CustomPageService } from './custom-service.js'
import { changeSection, defaultDefinition, fail, patchDefinition, sources, validateDefinition } from './model.js'
import { type AnalysisService, analysisHasUnsaved } from './service.js'

/**
 * What a page shows for its current version, for the agent to report as it is: a result read for this version's
 * task, or nothing. Told only why a refresh failed, an agent said the page still showed the last result; that
 * was an earlier task's, which the page does not show, and the page showed nothing.
 */
function shownResult(
  page: CustomPage,
): { result: { version: number; at: string } } | { result: null; message: string } {
  const current = currentResult(page)
  if (current) return { result: { version: page.version, at: current.endedAt ?? current.startedAt } }
  if (page.withheld)
    return {
      result: null,
      message: '你在 ORYH 的权限在上次取数后有变化，旧结果已隐藏，页面上不显示任何数据；刷新会按当前权限重新取数。',
    }
  const earlier = page.latest?.status === 'succeeded' ? page.latest : undefined
  if (!earlier) return { result: null, message: '页面还没有成功结果，页面上不显示任何数据。' }
  // The version before this one produced the result: going back to it shows that result again, without a refresh.
  const undo =
    page.previous?.version === earlier.version
      ? `撤销到上一版（oryh_custom_page_restore）会放弃第 ${page.version} 版的修改，并直接显示第 ${earlier.version} 版的结果。`
      : ''
  return {
    result: null,
    message: `第 ${page.version} 版还没有成功结果，页面上不显示任何数据。最近的成功结果属于第 ${earlier.version} 版，是按那一版的任务读取的，不适用于当前版本，页面不显示它，勿说页面仍显示旧结果。${undo}`,
  }
}

export function installAnalyticsTools(
  ctx: Context,
  records: OryhRecordRemote,
  service: AnalysisService,
  custom: CustomPageService,
) {
  const request = (id: string) => ({ sessionId: id, connectionId: ctx.oryhPane.home(id).connectionId })
  const customOpen = async (sessionId: string, id: string, signal: AbortSignal, show = false) => {
    const home = ctx.oryhPane.home(sessionId)
    const page = await custom.load({ ...request(sessionId), id })
    if (!ctx.oryhPane.entries(sessionId).some(v => v.id === id))
      return JSON.stringify({ saved: true, id, displayed: false, reason: '页面尚未首次成功运行，没有发布菜单。' })
    return ctx.oryhPane.issue(
      sessionId,
      {
        lane: 'navigation',
        page: 'analytics',
        payload: { target: 'view', userViewId: id, ...reveal(show) },
        timeoutMs: 20_000,
      },
      commandId => ({
        signal,
        invalid: () => (ctx.oryhPane.session(sessionId)?.scope !== home.scope ? '身份已变化。' : undefined),
        until: () => {
          const state = ctx.oryhPane.session(sessionId)
          if (!ctx.oryhPane.acked(sessionId, commandId) || state?.context?.key !== `custom:${id}`) return
          const shown = JSON.parse(state.context.content ?? '{}') as { version?: number; error?: string }
          if (shown.error || shown.version !== page.version) return
          return JSON.stringify({ saved: true, id, displayed: true, version: page.version, ...shownResult(page) })
        },
        expired: `页面已保存（${id}），但浏览器未确认展示。`,
      }),
    )
  }
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_catalog',
      description:
        '创建或修改自定义页面前读取写法：定义、数据约定、HTML 数据绑定、表单、刷新 Agent 怎么取数；给 collection 时再附上该 ORYH 集合的筛选字段和行字段（可对多个集合分别调用）。',
      parameters: { collection: { type: 'string', description: '可选：要作为任务来源的 ORYH 集合。' } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        const sessionId = String(exec.agent.id)
        const { connection } = await ctx.oryhPane.verified(sessionId)
        let filters: unknown
        let fields: { name: string }[] | undefined
        if (args.collection) {
          filters = await records.collectionFilterFields(connection.id, args.collection)
          fields = await records.collectionRowFields(connection.id, args.collection)
        }
        const sample = fields?.[0]?.name
        return JSON.stringify({
          ...(args.collection ? { collection: args.collection, filters, fields } : {}),
          modes:
            '页面有两种写法。Harness 组件页面（mode: "harness"）：definition.blocks 列出积木，客户端用 DeepSeek Harness 的组件画出来，外观与 Harness 一致，不写 html、css。完全自定义页面（mode: "html"）：写 html 和 css，在沙箱里渲染，版式任意。怎么选：用户说"用 Harness 组件""原生组件""标准组件"就用 harness，说"完全自定义""自由排版""用 HTML"就用 html；用户没说时用 harness（默认写法；definition 不写 mode 也按 harness 保存），用积木（文字、指标、表格、列表、图表、筛选、页签、折叠分区、表单、打开记录、问 Chat）把页面搭出来。页面需要积木没有的东西（自由排版、分栏定位、特殊图形或动效、积木以外的交互）时不要自己改用 html：先用积木做出最接近的，告诉用户哪一点积木做不到，用户说要完全自定义再换 html。保存后用一句话告诉用户用了哪种，并说想换可以直接说。换写法时 task、数据约定和 forms 不变，只换 blocks 或 html/css。',
          blocks:
            'Harness 组件页面的 blocks 是积木数组，每块一个对象，type 决定种类，绑定的字段都是数据约定里的名字。markdown {text}：Markdown（标题、列表、GFM 表格、公式），可写 {{字段}} 或 {{字段|money}} 插入顶层单值；fixed {}：显示 fixedText；markdown 和 fixedText 里不写链接和图片，链接只显示文字、点不开，图片不显示；metrics {items: [{label, field, format?}]}：一排指标卡，field 是顶层单值；table {data, columns: [{field, label, format?}], sortable?（默认 true）, pageSize?, open?, ask?, form?}：data 是数据约定里列出了字段的对象数组，列是数组项的字段，可排序、翻页；list {data, title, summary?, meta?: [{field, label, format?}], open?, ask?, form?}：卡片列表，title 等是数组项的字段；chart {kind: bar|line|pie, data, label, value, title?}：同一 label 的数值合并相加，所以按客户画订单金额时直接用订单数组即可；filter {targets: [数组名…], field?, label, control: text|select|pills}：即时过滤这些数组的表格、列表和图表；text 不写 field 时匹配任一字段，select 和 pills 要写 field（选项取这个字段的值）；tabs {tabs: [{label, blocks}]}：2 到 8 个页签；section {title, collapsible?, collapsed?, blocks}：分区，可折叠；form {name}：definition.forms 里的表单，页面按定义自动生成输入框、明细行和计算项，不用写任何标记。format 为 number、money、percent、date；open 为 "对象类型:字段"（如 sales_order:id），点了在 ORYH 打开这一行的记录；ask 为 [{label, question}]，点了把问题连同这一行发给 Chat；table 和 list 的 form 是每行一张的表单。最多嵌套 3 层、共 80 块。保存时逐块核对绑定，出错会指出是哪一块。',
          harnessExample: {
            title: '订单统计',
            mode: 'harness',
            blocks: [
              { type: 'markdown', text: '## {{headline}}\n数据截至 {{asOf|date}}' },
              {
                type: 'metrics',
                items: [
                  { label: '订单数', field: 'count', format: 'number' },
                  { label: '合计', field: 'total', format: 'money' },
                ],
              },
              { type: 'filter', targets: ['rows'], field: 'customer', label: '客户', control: 'text' },
              {
                type: 'tabs',
                tabs: [
                  {
                    label: '图表',
                    blocks: [{ type: 'chart', kind: 'bar', data: 'rows', label: 'customer', value: 'amount' }],
                  },
                  {
                    label: '明细',
                    blocks: [
                      {
                        type: 'table',
                        data: 'rows',
                        columns: [
                          { field: 'customer', label: '客户' },
                          { field: 'amount', label: '金额', format: 'money' },
                        ],
                        open: 'sales_order:id',
                        ask: [{ label: '看风险', question: '这一单有什么风险' }],
                      },
                    ],
                  },
                ],
              },
            ],
            fixedText: '',
            task: '同 example.task；数据约定要有 headline、asOf、count、total 和 rows（每项 id、customer、amount）',
            forms: [],
          },
          data: '页面数据由刷新 Agent 每次运行时读取并交付，它按 task.instruction 做事：用 oryh_custom_page_fetch 以当前用户身份读 ORYH 的任意只读接口（列表会自动读完；详情里的明细用 rows 取出；可以按上一步的结果继续读），存成命名数据集，再用 oryh_custom_page_calculate 统计、oryh_custom_page_arithmetic 精确加减，最后按数据约定交付。task.sources 可选：列出的集合在运行时按保存的筛选和列读取，适合"整张列表"；更复杂的取数（先查列表再逐单读详情、读报表接口、按上一步结果筛选）写进 instruction，写明读哪些接口、怎么关联、口径是什么，保证每次刷新可重复。你可以先在对话里用 oryh_request 的 GET 试一下接口和字段。',
          forms:
            '页面可以有表单，用户填写并把表单交给你后，你（Chat 里的 Agent）先在对话中列出将写入的内容和操作、等待明确确认，再按表单的 instruction 执行，写入走你自己的 ORYH 工具和技能，页面自己不写 ORYH。definition.forms 每项：name（模板里 form 的 data-oryh-form 用它）、label（按钮与确认标题）、instruction（提交后交给 Agent 的任务：要达成什么、按哪个技能执行，写具体）、fields、computed（可选）。fields 每项：name、label、type、required；type 为 text、textarea、number、date、checkbox、select、lines。select 二选一：options（固定选项）或 source: {data, value, label}（选项取自结果里的顶层数组 data，提交 value、显示 label；这个数组要写进数据约定并列出每项字段）。lines 是可增删的明细行：min、max（≤50）、fields（子字段，不能再嵌套 lines）、computed（每行的计算，只能 {name, label, multiply: [数字字段, 数字字段], zeroWhen?: 勾选框}）；明细里取自数据的 select 可加 defaults: {同行字段: 选项的字段}，选中后带出默认值（如单价）。表单级 computed 只能 {name, label, sum: "明细名.字段或计算项"}。计算只用于页面显示，确认框里是宿主精确算出的数。',
          formTemplate:
            '完全自定义页面的表单标记（Harness 组件页面不用写，用 {type: "form", name} 积木）：模板写 <form data-oryh-form="表单名">，里面放 name 与 fields 对应的 input/textarea/select（select 的选项由页面按定义填，模板里不写 option）、勾选框用 <input type="checkbox" name="x">、提交按钮。明细：<fieldset data-oryh-lines="明细名"><template>一行的输入框（外面包一个元素，比如 <div> 或 <tr>），行内可放 <button type="button" data-oryh-line-remove>删除</button> 和 <output name="计算项"></output></template><div></div><button type="button" data-oryh-line-add>加一行</button></fieldset>，行复制到紧随 template 的元素里。表单级计算放 <output name="计算项"></output>。候选项多时可加 <input data-oryh-options-filter="字段名"> 只缩小下拉列表。放在 template[data-oryh-each] 里时每行一张表单，提交时 Agent 会拿到这一行的数据。',
          formExample: {
            name: 'createOrder',
            label: '创建订单',
            instruction:
              '为所选客户创建一张销售订单：销售是当前用户；明细逐行写入，赠品行金额为 0；创建后不提交审批。按 oryh-order-submit 技能执行。',
            fields: [
              {
                name: 'customer',
                label: '客户',
                type: 'select',
                required: true,
                source: { data: 'customers', value: 'id', label: 'name' },
              },
              { name: 'order_date', label: '订单日期', type: 'date', required: true },
              { name: 'currency', label: '币种', type: 'select', required: true, options: ['CNY', 'USD'] },
              {
                name: 'items',
                label: '明细',
                type: 'lines',
                required: true,
                min: 1,
                max: 20,
                fields: [
                  {
                    name: 'product',
                    label: '产品',
                    type: 'select',
                    required: true,
                    source: { data: 'products', value: 'id', label: 'name' },
                    defaults: { unit_price: 'price' },
                  },
                  { name: 'quantity', label: '数量', type: 'number', required: true },
                  { name: 'unit_price', label: '单价', type: 'number', required: true },
                  { name: 'is_gift', label: '赠品', type: 'checkbox', required: false },
                ],
                computed: [
                  { name: 'amount', label: '金额', multiply: ['quantity', 'unit_price'], zeroWhen: 'is_gift' },
                ],
              },
            ],
            computed: [{ name: 'total', label: '合计', sum: 'items.amount' }],
          },
          htmlBinding:
            '<main><h1 data-oryh-field="headline"></h1><p>合计 <b data-oryh-field="total" data-oryh-format="money"></b></p><div data-oryh-chart="bar" data-oryh-data="rows" data-oryh-label="customer" data-oryh-value="amount"></div><table data-oryh-sortable><thead><tr><th>客户</th><th>金额</th></tr></thead><template data-oryh-each="rows"><tr><td data-oryh-field="customer"></td><td data-oryh-field="amount" data-oryh-format="money"></td></tr></template><tbody></tbody></table><section data-oryh-fixed></section></main>',
          bindings:
            '完全自定义页面的数据绑定：data-oryh-field 填值，data-oryh-format 可为 number、money、percent、date；template[data-oryh-each] 按数组重复，副本放进紧随其后的元素（表格里就是 tbody）；后面没有元素时副本接在 template 后面，所以卡片容器里只放一个 template 即可；可嵌套；data-oryh-chart 为 bar、line、pie，配 data-oryh-data（数组字段）、data-oryh-label、data-oryh-value，同一 label 的数值合并相加、没有数值的行不画，和 chart 积木一样；table[data-oryh-sortable] 点表头排序；data-oryh-fixed 放固定正文。页面内筛选：<input data-oryh-filter="rows" data-oryh-filter-field="customer">（或 select；select 不写 option 时自动列出这个字段的所有值），按输入即时过滤该数组的行和由它画的图，不调用模型；不写 data-oryh-filter-field 时匹配任一字段；一个输入框要同时过滤几张表，就在 data-oryh-filter 里写上这几个数组名、用空格或逗号分隔（如 "rows orders"），各数组按同名字段过滤。打开记录：在行内元素上写 data-oryh-open="对象类型:字段"（如 sales_order:id），点击在 ORYH 中打开这一行的记录，行里要带上记录 id。问 Chat：<button data-oryh-ask="这一单为什么有风险">，点击后把问题连同这一行的数据发给 Chat。不能写脚本、事件属性、链接、外部图片或 SVG。',
          style:
            '完全自定义页面已自动套用工作台的主题（深色或浅色）：字体、文字与背景颜色、标题字号、表格、数字右对齐和图表颜色都已设好。css 只写布局（间距、栅格、列宽、分栏），不要设置 color、background、font-family、font-size、border 颜色；确需强调时用 var(--accent)、var(--muted)、var(--line)、var(--surface) 等变量。h1 只放简短标题，说明文字放 p。',
          example: {
            title: '自定义页面',
            mode: 'html',
            html: '<main><h1 data-oryh-field="headline"></h1><p>合计 <b data-oryh-field="total" data-oryh-format="money"></b></p><table data-oryh-sortable><thead><tr><th>客户</th><th>金额</th></tr></thead><template data-oryh-each="rows"><tr><td data-oryh-field="customer"></td><td data-oryh-field="amount" data-oryh-format="money"></td></tr></template><tbody></tbody></table></main>',
            css: '',
            script: '',
            fixedText: '',
            task: {
              instruction: sample
                ? '明确写出筛选、统计口径、币种和时间边界，并只根据 ORYH 原始数据产生结果。'
                : '写明读哪些接口（例如先读 /sales-orders?status=confirmed，再逐单读 /sales-orders/{id}/detail 取调整后金额）、怎么关联、统计口径、币种和时间边界，并只根据 ORYH 原始数据产生结果。',
              timeZone: 'Asia/Shanghai',
              sources:
                sample && args.collection
                  ? [
                      {
                        collection: args.collection,
                        filters: {},
                        display: { columns: [{ field: sample, label: sample }] },
                      },
                    ]
                  : [],
              contract: {
                fields: [
                  { name: 'headline', type: 'string', required: true },
                  { name: 'total', type: 'string', required: true },
                  {
                    name: 'rows',
                    type: 'array',
                    required: true,
                    fields: [
                      { name: 'id', type: 'string', required: true },
                      { name: 'customer', type: 'string', required: true },
                      { name: 'amount', type: 'string', required: true },
                    ],
                  },
                ],
              },
            },
            forms: [],
          },
          contract:
            'task.contract.fields 是字段列表，每项只有 name、type（string、number、boolean、object、array）、required，以及可选的 fields：object 用 fields 列出它的键，array 的每一项是对象时用 fields 列出每项的键；最多嵌套 3 层。没有其他写法（没有 items、properties）。结果必须严格符合：不能多字段，必填不能缺。',
          limits:
            '一次刷新最多读 ORYH 200 次（分页也算）、每个数据集最多 1000 条、合计 2 万条、3 分钟；task.sources 最多 8 个；刷新 Agent 用精确计算工具做记录数、去重计数、按单位求和，可筛选、按日期分桶、关联另一个数据集；不执行模型生成的脚本。',
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_fetch',
      description:
        '仅供独立页面刷新 Agent 使用：以当前用户身份读 ORYH 的一个只读接口（/api/v1 之后的路径，如 /sales-orders、/sales-orders/{id}/detail），把回应存成数据集 name。回应是列表时自动分页读完（最多 1000 条，超出须加筛选）；是单条记录时存成一行；rows 可取出记录里的列表（如详情的 items）。嵌套对象的字段写成 a.b。返回总数和第一页，之后用 oryh_custom_page_read 翻页、oryh_custom_page_calculate 统计。一次运行最多读 200 次（分页也算），不要给 page、size。',
      parameters: {
        name: { type: 'string', required: true, description: '数据集名，字母开头，如 orders、order_detail_1。' },
        path: {
          type: 'string',
          required: true,
          description: '如 /sales-orders 或 /sales-orders/3f…/detail，不带查询串。',
        },
        query: { type: 'string', description: '查询参数，如 status=confirmed&customer_id=3f…。' },
        rows: { type: 'string', description: '回应是单条记录时，取其中哪个列表作为行，如 items。' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要 Agent 会话。')
        return custom.fetch(String(exec.agent.id), {
          name: args.name,
          path: args.path,
          ...(args.query ? { query: args.query } : {}),
          ...(args.rows ? { rows: args.rows } : {}),
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_read',
      description:
        '仅供独立页面刷新 Agent 使用：翻看一个数据集的记录，或读取任务列出的来源（第一次调用完整读取整个来源，统计与来源记录以此为准）。每次只返回一页记录（按字段名），带 total 和下一页的 offset（next）；需要逐条内容时再翻页，总数、金额和分组统计用 oryh_custom_page_calculate。',
      parameters: {
        name: { type: 'string', required: true, description: '数据集名：fetch 时给的 name，或任务来源的集合名。' },
        offset: { type: 'integer', description: '从第几条开始，默认 0。' },
        limit: { type: 'integer', description: '本页条数，默认 50，最多 200。' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要 Agent 会话。')
        return custom.read(String(exec.agent.id), args.name, args.offset ?? 0, args.limit ?? 50)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_calculate',
      description:
        '仅供独立页面刷新 Agent 使用：对已读取的数据集做确定性统计，collection 是数据集名（fetch 时给的 name，或任务来源的集合名）。operation: count（记录数）、sum（六位小数精确求和，必须给 measure 和 unitField，按单位分开）、count_distinct（measure 字段去重计数）。groupBy 可以是一个或最多 3 个字段，日期字段可写 field@day / @month / @year，按任务时区分桶。where 是条件列表：{field, op, value}，op 为 eq、ne、in、not_in、from、before（日期，按任务时区，value 为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm）、empty、not_empty。join 把另一个已读取的数据集按键关联：{collection（数据集名）, localField, foreignField（默认 id）, unmatched: "fail"|"exclude"}，关联后可用 "数据集名.字段" 引用其字段。字段必须是数据集里有的字段（嵌套字段写 a.b）或 id；结果附来源记录 ID。',
      parameters: {
        collection: { type: 'string', required: true },
        operation: { type: 'string', enum: ['count', 'sum', 'count_distinct'], required: true },
        groupBy: { type: 'array', items: { type: 'string' } },
        measure: { type: 'string' },
        unitField: { type: 'string' },
        where: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string', required: true },
              op: {
                type: 'string',
                enum: ['eq', 'ne', 'in', 'not_in', 'from', 'before', 'empty', 'not_empty'],
                required: true,
              },
              value: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                description: '单个值，或 in / not_in 的一组值。',
              },
            },
          },
        },
        join: {
          type: 'object',
          additionalProperties: false,
          properties: {
            collection: { type: 'string', required: true },
            localField: { type: 'string', required: true },
            foreignField: { type: 'string' },
            unmatched: { type: 'string', enum: ['fail', 'exclude'] },
          },
        },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要 Agent 会话。')
        // The schema above has shaped every field; the calculation checks what each one names.
        return custom.calculate(String(exec.agent.id), args as unknown as CalculationRequest)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_arithmetic',
      description:
        '仅供独立页面刷新 Agent 使用：对已算出的数值做精确加减（六位小数），例如订单明细合计加调整金额。只对同一币种或单位的数值使用；add 把所有值相加，subtract 用第一个值依次减去其余的值。',
      parameters: {
        operation: { type: 'string', enum: ['add', 'subtract'], required: true },
        values: { type: 'array', items: { type: 'string' }, required: true, description: '数值文本，如 "121600.00"。' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要 Agent 会话。')
        return custom.arithmetic(String(exec.agent.id), args.operation as 'add' | 'subtract', args.values)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_publish',
      description: '仅供独立页面刷新 Agent 使用：交付符合保存的数据约定的 JSON 对象，不得编造事实。',
      parameters: { resultJson: { type: 'string', required: true } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要 Agent 会话。')
        return custom.publish(String(exec.agent.id), args.resultJson)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_list',
      description: '列出当前创建者在工作区和企业内保存的自定义页面及版本、运行状态。',
      parameters: {},
      output: textOutput,
      execute: async (_args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        return JSON.stringify(
          (await custom.listSummaries(request(String(exec.agent.id)))).map(page => ({
            id: page.id,
            title: page.title,
            version: page.version,
            available: page.available,
            latest: page.latest,
            run: page.run,
          })),
        )
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_get',
      description: '按 id 读取一张个人页面的完整定义与版本以便继续编辑；不返回缓存业务数据。',
      parameters: { id: { type: 'string', required: true } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        const page = await custom.load({ ...request(String(exec.agent.id)), id: args.id })
        return JSON.stringify({
          id: page.id,
          version: page.version,
          definition: page.definition,
          latest: page.latest && {
            version: page.latest.version,
            at: page.latest.endedAt,
            sources: page.latest.sources?.map(source => ({
              collection: source.collection,
              total: source.total,
              firstFetchedAt: source.firstFetchedAt,
              fetchedAt: source.fetchedAt,
            })),
          },
          run: page.run && { status: page.run.status, error: page.run.error },
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_save',
      description:
        '创建或编辑个人页面。两种写法（见 catalog 的 modes）：Harness 组件页面 mode 为 "harness"，写 blocks（见 catalog 的 blocks、harnessExample），不写 html、css；完全自定义页面 mode 为 "html"，写 html 和 css（script 必须为空字符串），css 只写布局、不设颜色背景字体（见 catalog 的 style、bindings）。用户在 Chat 里指定了写法就照做，没指定用 harness（见 catalog 的 modes）。页面上需要让用户填写并提交时，在 forms 里声明（见 catalog 的 forms、formExample）：用户把表单交给你后，提交会作为用户的一轮对话交给你；先在对话中列出写入内容和操作、等待明确确认，再按表单的 instruction 执行；页面自己不写 ORYH，你也不能替用户提交。definitionJson 包含 title、mode、blocks 或 html/css、forms（可选）、fixedText 与独立可执行的 task（instruction、sources（可选）、timeZone、contract）。修改须传 id 和 expectedVersion。仅保存草稿，不代表已取数或展示。',
      parameters: {
        definitionJson: { type: 'string', required: true },
        id: { type: 'string' },
        expectedVersion: { type: 'integer' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        let value: unknown
        try {
          value = JSON.parse(args.definitionJson)
        } catch {
          customFail('定义不是有效 JSON。')
        }
        const definition = customDefinitionSchema.parse(value)
        const saved = await custom.save({
          ...request(String(exec.agent.id)),
          definition,
          ...(args.id ? { id: args.id } : {}),
          ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }),
        })
        return JSON.stringify({
          saved: true,
          id: saved.id,
          version: saved.version,
          needsRefresh: saved.latest?.version !== saved.version,
          displayed: false,
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_run',
      description:
        '首次运行或手动刷新保存的页面，在隔离 DSH Agent 会话读取 ORYH 数据并校验结果；成功后发布个人菜单。返回的 result 是页面上显示的当前版本结果，null 表示页面上没有数据；刷新失败时 refreshed=false，按 message 说明页面现在显示什么。',
      parameters: {
        id: { type: 'string', required: true },
        expectedVersion: { type: 'integer', required: true },
        language: {
          type: 'string',
          description: 'Use the conversation language (en or zh) for refresh progress and its session title.',
        },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        const sessionId = String(exec.agent.id)
        let page: CustomPage
        try {
          page = await custom.run(
            { ...request(sessionId), id: args.id, expectedVersion: args.expectedVersion, language: args.language },
            exec.signal,
          )
        } catch (error) {
          // Said with what the page shows now, which is not always the last result (see shownResult). A page
          // that cannot be read has nothing to describe, and the refresh's own error stands.
          let now: CustomPage
          try {
            now = await custom.load({ ...request(sessionId), id: args.id })
          } catch {
            throw error
          }
          const shown = shownResult(now)
          return JSON.stringify({
            refreshed: false,
            id: now.id,
            version: now.version,
            error: error instanceof Error ? error.message : '刷新失败。',
            displayed: false,
            ...shown,
            ...(shown.result
              ? { message: `这次刷新没有更新数据，页面继续显示上次成功的结果（生成于 ${shown.result.at}）。` }
              : {}),
          })
        }
        try {
          return await customOpen(sessionId, page.id, exec.signal)
        } catch (error) {
          return JSON.stringify({
            saved: true,
            id: page.id,
            version: page.version,
            displayed: false,
            ...shownResult(page),
            message: error instanceof Error ? error.message : '浏览器未确认展示。',
          })
        }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_open',
      description:
        '打开已首次运行成功的个人自定义页面，并等待浏览器真实回执；打开不刷新数据。返回的 result 为 null 时页面上没有当前版本的数据，message 说明原因。',
      parameters: { id: { type: 'string', required: true }, show: SHOW_PARAMETER },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        return customOpen(String(exec.agent.id), args.id, exec.signal, args.show === true)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_restore',
      description: '将个人页面恢复至上一版定义，须提供当前 id/version；可能需要重新刷新数据。',
      parameters: { id: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        const page = await custom.restore({
          ...request(String(exec.agent.id)),
          id: args.id,
          expectedVersion: args.expectedVersion,
        })
        return JSON.stringify({
          restored: true,
          id: page.id,
          version: page.version,
          needsRefresh: page.latest?.version !== page.version,
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_migrate',
      description:
        '把当前用户的旧“分析与报告”迁移为自定义页面：每份旧分析变成一张待首次运行的页面，口径、排序、前 N 项和报告章节原样保留；已迁移过的跳过，无法如实迁移的给出原因并保留旧分析。只在用户要求迁移时调用。',
      parameters: {},
      output: textOutput,
      execute: async (_args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        const r = request(String(exec.agent.id))
        return JSON.stringify(await custom.migrate(r, await service.list(r)))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_custom_page_delete',
      description: '仅在用户明确要求删除该个人页面时删除；须提供当前 id/version。不会修改 ORYH 业务记录。',
      parameters: { id: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        await custom.delete({ ...request(String(exec.agent.id)), id: args.id, expectedVersion: args.expectedVersion })
        return JSON.stringify({ deleted: true, id: args.id })
      },
    }),
  )
  async function open(sessionId: string, id: string, signal: AbortSignal) {
    const home = ctx.oryhPane.home(sessionId)
    if (home.page === 'analytics' && analysisHasUnsaved(home.context))
      throw fail('分析页面有未保存修改，请先保存或放弃。')
    const view = await service.load({ ...request(sessionId), id })
    signal.throwIfAborted()
    ctx.oryhPane.assertUnchanged(sessionId, home)
    return ctx.oryhPane.issue(
      sessionId,
      {
        lane: 'navigation',
        page: 'analytics',
        payload: { target: 'analysis', page: 'analytics', analysisId: id },
        timeoutMs: 20000,
      },
      commandId => ({
        signal,
        invalid: () => (ctx.oryhPane.session(sessionId)?.scope !== home.scope ? '企业已变化。' : undefined),
        until: () => {
          const context = ctx.oryhPane.session(sessionId)?.context
          if (!ctx.oryhPane.acked(sessionId, commandId) || context?.key !== `analytics:${id}` || !context.content)
            return
          const displayed = JSON.parse(context.content) as { loading?: boolean; error?: string; version?: number }
          if (displayed.loading) return
          if (displayed.error) return JSON.stringify({ saved: true, id, displayed: false, error: displayed.error })
          if (displayed.version !== view.document.version) return
          return JSON.stringify({ saved: true, id, displayed: true, page: currentPage(ctx.oryhPane, sessionId) })
        },
        expired: `分析已保存（${id}），但页面未确认展示；请重新打开，勿声称已显示。`,
      }),
    )
  }
  ctx.tools.register(
    defineTool({
      name: 'oryh_analysis_catalog',
      description:
        '创建图表或可编辑报告前先读取受支持的数据源、分组、指标、筛选字段和完整定义示例。结果只包含当前账号可访问来源。第一版支持销售订单、库存余额、库存流水、收发货；不支持项目、任意 SQL、跨对象关联、预测。',
      parameters: {},
      output: textOutput,
      execute: async (_args, exec) => {
        if (!exec.agent) throw fail('需要会话。')
        const r = request(String(exec.agent.id)),
          scope = await service.scope(r)
        const available = []
        for (const [source, spec] of Object.entries(sources)) {
          if (!canAccessPage(scope.connection.identity, source)) continue
          available.push({
            source,
            ...spec,
            labels: recordColumns(source as keyof typeof sources),
            filters: await records.recordFilterFields(r.connectionId, source as keyof typeof sources),
          })
        }
        return JSON.stringify({
          sources: available,
          example: defaultDefinition(),
          limit: 1000,
          rules:
            'sort=label/value-desc/value-asc；topN=0 显示全部，topN=1～50 且 sort=value-desc 将记录数的其余组合并为其他，金额/数量不支持合并。sections 为按顺序显示的报告章节，id 稳定，title/body 纯文本。count 是记录数。total_amount 仅按 currency 分组；库存数量仅按 product_code、流水数量仅按 inventory_item_id 分组。保存后按当前权限重新取数，不保存数据快照。只统计当前筛选全量，无法完成全量读取则拒绝。用户说当前列表时保留其 query、queryValues、productIds；不认识的条件先询问，不得丢弃。',
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_analysis_list',
      description: '列出当前工作区、企业和用户已保存的图表及报告定义，用于按标题重新打开或修改。',
      parameters: {},
      output: textOutput,
      execute: async (_args, exec) => {
        if (!exec.agent) throw fail('需要会话。')
        return JSON.stringify(await service.list(request(String(exec.agent.id))))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_analysis_save',
      description:
        '创建图表/可编辑报告或替换完整查询定义，保存并打开中间栏；只改标题、类型、正文等请优先使用 oryh_analysis_update。先读 catalog。definitionJson 是完整定义 JSON（示例见 catalog），不得放入模型计算的数字、代码或 HTML。仅修改时传 id 和 expectedVersion；先读取当前页面或 list，并保留未要求修改的字段。当前页面存在手工未保存修改时必须先让用户保存或放弃。只存个人展示定义与说明，不写 ORYH 业务记录；summary/findings/nextSteps 是可编辑纯文本，不得编造事实。成功必须以 displayed 与实际页面回执为准。',
      parameters: {
        definitionJson: { type: 'string', required: true },
        id: { type: 'string' },
        expectedVersion: { type: 'integer' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw fail('需要会话。')
        const sessionId = String(exec.agent.id),
          home = ctx.oryhPane.home(sessionId)
        if (home.page === 'analytics' && analysisHasUnsaved(home.context))
          throw fail('分析页面有未保存修改，请先保存或放弃。')
        let raw: unknown
        try {
          raw = JSON.parse(args.definitionJson)
        } catch {
          throw fail('分析定义不是有效 JSON。')
        }
        exec.signal.throwIfAborted()
        const view = await service.save(
          {
            ...request(sessionId),
            definition: validateDefinition(raw),
            ...(args.id ? { id: args.id } : {}),
            ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }),
          },
          exec.signal,
        )
        try {
          ctx.oryhPane.assertUnchanged(sessionId, home)
          return await open(sessionId, view.document.id, exec.signal)
        } catch (error) {
          return JSON.stringify({
            saved: true,
            displayed: false,
            id: view.document.id,
            version: view.document.version,
            message: error instanceof Error ? error.message : '页面未确认展示。',
          })
        }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_analysis_open',
      description: '按 analysis_list 的 id 打开已保存的图表或报告，重新按当前权限取数并等待页面回执。',
      parameters: { id: { type: 'string', required: true } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw fail('需要会话。')
        return open(String(exec.agent.id), args.id, exec.signal)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_analysis_update',
      description:
        '局部修改已有图表或报告并保存、打开页面。传当前 id/version 和只需改变的字段；未传字段由服务保留。转报告用 kind=report；标题用 title；正文 summary/findings/nextSteps 可传空字符串清空。排序用 sort，前 N 项用 topN；章节增删改及移动使用 analysis_section。先读取当前页面或 analysis_list；不能覆盖页面手工未保存内容，不修改库存等业务记录。',
      parameters: {
        id: { type: 'string', required: true },
        expectedVersion: { type: 'integer', required: true },
        title: { type: 'string' },
        kind: { type: 'string', enum: ['chart', 'report'] },
        groupBy: { type: 'string' },
        measure: { type: 'string' },
        display: { type: 'string', enum: ['bar', 'table'] },
        sort: { type: 'string', enum: ['label', 'value-desc', 'value-asc'] },
        topN: {
          type: 'integer',
          description: '0 表示全部；1～50 表示按记录数降序取前 N 项并合并其他，仅 count 支持，同时设 sort=value-desc。',
        },
        summary: { type: 'string' },
        findings: { type: 'string' },
        nextSteps: { type: 'string' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw fail('需要会话。')
        const sessionId = String(exec.agent.id),
          home = ctx.oryhPane.home(sessionId)
        if (home.page === 'analytics' && analysisHasUnsaved(home.context))
          throw fail('分析页面有未保存修改，请先保存或放弃。')
        const { id, expectedVersion, ...changes } = args
        const old = (await service.list(request(sessionId))).find(d => d.id === id)
        if (!old || old.version !== expectedVersion) throw fail('分析不存在或版本已变化，请重新读取。')
        const definition = patchDefinition(old.definition, changes)
        const view = await service.save({ ...request(sessionId), id, expectedVersion, definition }, exec.signal)
        try {
          ctx.oryhPane.assertUnchanged(sessionId, home)
          return await open(sessionId, id, exec.signal)
        } catch (error) {
          return JSON.stringify({
            saved: true,
            displayed: false,
            id,
            version: view.document.version,
            message: error instanceof Error ? error.message : '页面未确认展示。',
          })
        }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'oryh_analysis_section',
      description:
        '编辑报告的一节，保存并显示页面。先读当前 definition.sections 与 version。add 新增，update 改标题/正文，remove 删除，move 移动；使用稳定 sectionId，不凭序号猜编号。afterId 为空字符串表示放第一节，add 未提供则放最后。其他章节及统计设置保留；不覆盖手工草稿。',
      parameters: {
        id: { type: 'string', required: true },
        expectedVersion: { type: 'integer', required: true },
        action: { type: 'string', enum: ['add', 'update', 'remove', 'move'], required: true },
        sectionId: { type: 'string', description: 'update/remove/move 必填，add 不传。' },
        title: { type: 'string' },
        body: { type: 'string' },
        afterId: { type: 'string' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) throw fail('需要会话。')
        const sessionId = String(exec.agent.id),
          home = ctx.oryhPane.home(sessionId)
        if (home.page === 'analytics' && analysisHasUnsaved(home.context))
          throw fail('分析页面有未保存修改，请先保存或放弃。')
        const old = (await service.list(request(sessionId))).find(d => d.id === args.id)
        if (!old || old.version !== args.expectedVersion) throw fail('分析不存在或版本已变化，请重新读取。')
        if (args.action !== 'add' && !args.sectionId) throw fail('请提供当前报告中的 sectionId。')
        const definition = changeSection(old.definition, {
          ...args,
          sectionId: args.action === 'add' ? randomUUID() : args.sectionId!,
        })
        const view = await service.save(
          { ...request(sessionId), id: args.id, expectedVersion: args.expectedVersion, definition },
          exec.signal,
        )
        try {
          ctx.oryhPane.assertUnchanged(sessionId, home)
          return await open(sessionId, args.id, exec.signal)
        } catch (error) {
          return JSON.stringify({
            saved: true,
            displayed: false,
            id: args.id,
            version: view.document.version,
            message: error instanceof Error ? error.message : '页面未确认展示。',
          })
        }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: CHAT_FORM_TOOL,
      description:
        '在对话里显示一张表单请用户填写：用户要录入、填报或登记一件有若干项内容的事（填工时、报销、下订单、登记跟进等）时用它，不要一句一句地问，也不要为此新建自定义页面。表单出现在你这条回答的下面；本工具立刻返回，不等用户。用户提交后，填写内容会作为他的下一条消息发给你，那时再按写入前确认的规则办。' +
        'formJson 是 JSON：{form, data?, values?}。form：name（英文标识）、label（表单名，24 字内）、instruction（用户提交后你要做什么：达成什么、按哪个技能执行，写具体，至少 10 个字）、fields、computed（可选）。' +
        'fields 每项：name（英文标识）、label、type、required；type 为 text、textarea、number、date、checkbox、select、record、lines。select 二选一：options（固定选项的字符串数组）或 source: {data, value, label}（选项取自 data 里的同名数组，提交 value、显示 label）。record 是从 ORYH 的一个集合里选一条记录：用户点放大镜，在弹出框里按名称或编码搜索并选中，提交的是这条记录的编号和名称；写 lookup: {collection, label, code?}，collection 是集合名（接口路径里的名字，如 customers、products、projects、suppliers、warehouses、employees、sales-quotes），label 是记录里当名称显示的字段，code 是可选的第二个显示字段（编码、单号）；不确定集合名或字段名时先用 oryh_record_filter_fields 或读一页数据确认。record 字段不能预填。' +
        '规则，适用于所有单据：凡是指向 ORYH 里另一条记录的字段（外键：客户、供应商、项目、店铺、仓库、员工、产品、报价单、订单、合同等，字段名通常以 _id 结尾），一律不能让用户手填，必须是选择——候选不多（几十个以内）且你已经读出来的用 select 加 source，其余用 record 加 lookup。名字以 _id 结尾的 text、number 字段会被拒绝。单据上既有外键又有名称快照时（如 customer_id 和 customer_name），表单里只放一个 record 字段，名称由所选记录带出，不要改成让用户填名称。只有 ORYH 里本来就是自由文本的字段（备注、地址、联系人、电话、外部单号）才用 text。用户要选的记录在 ORYH 里还不存在时，先在对话里和他确认新建，再出表单。' +
        'lines 是可增删的明细行：min、max（≤50）、fields（子字段，不能再嵌套 lines）、computed（每行的计算，只能 {name, label, multiply: [数字字段, 数字字段], zeroWhen?: 勾选框字段}）；明细里取自 data 的 select 可加 defaults: {同行字段: 选项的字段}，选中后带出默认值。表单级 computed 只能 {name, label, sum: "明细名.字段或计算项"}。' +
        'data（可选）：给下拉用的选项，{名字: [{…}, …]}，每个数组最多 200 项，值只能是文字、数字、布尔；选项要先从 ORYH 读出来（如项目、客户、产品），不要编。values（可选）：预填的值，{字段名: 值}，明细给数组；已经知道的（日期、用户刚说的内容）先填上。' +
        '字段按 ORYH 的技能和接口说明定：必填的都要有，标签、选项、说明和验证文案全部使用用户要求的语言（英文请求必须全部英文），不放用户不该填的内部字段。对话栏很窄，明细的列控制在 4 个以内。',
      parameters: { formJson: { type: 'string', required: true } },
      output: textOutput,
      execute: async (args, exec) => {
        if (!exec.agent) customFail('需要会话。')
        let value: unknown
        try {
          value = JSON.parse(args.formJson)
        } catch {
          customFail('formJson 不是有效 JSON。')
        }
        let shown: ReturnType<typeof parseChatForm>
        try {
          shown = parseChatForm(value)
        } catch (error) {
          customFail(error instanceof Error ? error.message : '表单定义无效。')
        }
        return JSON.stringify({ shown: true, form: shown.form.label, note: CHAT_FORM_SHOWN })
      },
    }),
  )
}
