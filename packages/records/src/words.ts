/**
 * What ORYH's states and fields are called, in one place, for the pages and for the agent alike.
 *
 * The pages translated as they showed: a list said 已发货 where the agent, reading the same record over
 * the API, said `shipped`; a detail said 订单号 where the agent said `order_no`, and the todo page, with a
 * table of its own, showed half an order under the API's field names. The same document in two
 * vocabularies reads as two documents (docs/56 §5). So the words live here: the pages show them, and the
 * agent is given the same table and told to speak them.
 *
 * Only words: nothing is shown, hidden or allowed by these tables. A state or field they do not know is
 * the tenant's own — a workspace may rename a state or add an object — and is shown as it came.
 */
import { childLabels, fieldLabels, recordSpecs } from './views.js'

/**
 * State names ORYH ships in its default machines, for the documents this client shows. Words follow the
 * approver's own buttons (通过 / 拒绝 / 退回修改), so one state reads the same on every page.
 */
export const statusWords: Readonly<Record<string, string>> = {
  draft: '草稿',
  submitted: '已提交',
  approved: '已通过',
  rejected: '已拒绝',
  returned: '已退回',
  cancelled: '已取消',
  commented: '已评论',
  paid: '已支付',
  confirmed: '已确认',
  accepted: '已接受',
  packed: '已打包',
  shipped: '已发货',
  signed: '已签收',
  received: '已收货',
  open: '待处理',
  completed: '已完成',
  closed: '已关闭',
  active: '进行中',
  archived: '已归档',
}

/**
 * @param status - a state as the server sent it.
 * @returns its display word; an unknown state shows as it came rather than borrowing another's meaning.
 */
export function statusLabel(status: string): string {
  return Object.hasOwn(statusWords, status) ? statusWords[status]! : status
}

/**
 * Field names, as a person reads them. The lists' own column names come first (`fieldLabels`); the rest
 * are fields a document's detail carries that no list shows as a column, which the todo page used to
 * print under their API names.
 */
export const fieldWords: Readonly<Record<string, string>> = {
  id: '编号',
  contact_name: '联系人',
  contact_phone: '联系电话',
  contact_email: '联系邮箱',
  ship_to_address: '收货地址',
  signed_at: '签收时间',
  sent_at: '发送时间',
  closed_at: '关闭时间',
  completed_at: '完成时间',
  due_at: '到期时间',
  logistics_company: '物流公司',
  logistics_tracking_no: '运单号',
  source_quote_number: '来源报价编号',
  quote_total: '报价合计',
  order_total: '订单合计',
  computed_total: '明细合计',
  adjusted_total: '调整后合计',
  adjustments_total: '调整金额',
  outcome_note: '结果说明',
  sku_pending: '规格待定',
  revision: '版本标识',
  superseded_by: '已被替代为',
  customer_name_snapshot: '客户',
  vendor_name_snapshot: '供应商',
  submitted_at: '提交时间',
  quote_drift: '与报价的差额',
  estimated_total: '估算合计',
  payment_terms: '付款条件',
  delivery_terms: '交付条件',
  valid_until: '有效期至',
  quote_date: '报价日期',
  quote_number: '报价编号',
  revision_no: '版本',
  approver_id: '审批人',
  sequence_no: '审批节点',
  ...fieldLabels,
}

/**
 * @param field - a field name as the API has it.
 * @returns what a person calls it, or the name itself where nobody has given it a better one.
 */
export function fieldLabel(field: string): string {
  return Object.hasOwn(fieldWords, field) ? fieldWords[field]! : field
}

/**
 * Whether a label is still one of the built-in labels for this field, as against one a tenant chose.
 * A built-in list may give a field a closer label than the shared one (a sales order's `total_amount`
 * is 订单总额 there); a tenant's own label is not translated even when it copies a built-in word.
 * @param field - a field name as the API has it.
 * @param label - the label shown for it.
 */
export function isBuiltInFieldLabel(field: string, label: string): boolean {
  if (fieldLabel(field) === label || fieldLabels[field] === label) return true
  for (const spec of Object.values(recordSpecs))
    if ((spec.fields as Record<string, string>)[field] === label) return true
  return false
}

/**
 * What a field is called on one kind of document, where that document's own page has a closer word than
 * the one every document shares: a sales order's `total_amount` is 订单总额 on its list, and so it is
 * wherever else that order is shown.
 * @param objectType - the document's type as ORYH names it, e.g. `sales_order`.
 * @param field - a field name as the API has it.
 */
export function fieldLabelFor(objectType: string, field: string): string {
  for (const [kind, spec] of Object.entries(recordSpecs))
    if (kind.replaceAll('-', '_').replace(/s$/, '') === objectType && Object.hasOwn(spec.fields, field))
      return (spec.fields as Record<string, string>)[field]!
  return fieldLabel(field)
}

/**
 * @param name - a part of a document as the API names it: `items`, `approval_records`.
 * @returns what that part is called, or what a field of that name is called, or the name itself.
 */
export function sectionLabel(name: string): string {
  return Object.hasOwn(childLabels, name) ? childLabels[name]! : fieldLabel(name)
}

/** Whether a field holds a state, by its name: `status`, `approval_status`. */
export const isStatusField = (field: string): boolean => field === 'status' || field.endsWith('_status')

/**
 * A state as a person may type it, back to what the server knows it by: 已发货 is `shipped`. Anything
 * else — the server's own value, a tenant's own state — is what was typed.
 */
export function statusValue(typed: string): string {
  const text = typed.trim()
  const known = Object.entries(statusWords).find(([, word]) => word === text)
  return known ? known[0] : text
}

/**
 * One condition a list is narrowed by, as a person reads it: 状态：待处理, not `status = open`.
 * @param field - the condition's name as the API has it.
 * @param value - what it is held to.
 */
export function conditionText(field: string, value: string): string {
  return `${fieldLabel(field)}：${isStatusField(field) ? statusLabel(value) : value}`
}

const pairs = (words: Readonly<Record<string, string>>) =>
  Object.entries(words)
    .map(([name, word]) => `${name}=${word}`)
    .join('、')

/**
 * The agent's copy of the tables: the standing rule that makes Chat say what the page says.
 * @returns one rule for the system prompt.
 */
export function vocabularyRule(): string {
  return `Match the language requested in the conversation. For English replies, use English business display labels for built-in states, fields, collections and menus; never force Chinese wording from the tables below into an English reply. These tables are Chinese UI vocabulary for Chinese replies only. Do not rename stored records or change API identifiers to translate a reply. For a tenant-authored label without an English display label, an English description or its stable identifier can identify it without copying Chinese text into an English-only reply.\n仅在用户要求中文时，状态和字段用页面上的中文叫法。状态：${pairs(statusWords)}。字段：${pairs(fieldWords)}。单据的各部分：${pairs(childLabels)}。中文回复中，这几张表里没有的状态或字段是企业自定义的：照原样写，不要自行改名。需要对照接口原值时，在中文后用括号附一次原值。`
}
