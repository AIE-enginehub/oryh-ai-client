import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { TodoDocument } from '@oryh/ai-client-todos'
import {
  BusinessSessionContext,
  Button,
  formatDateTime,
  formatDisplayValue,
  statusLabel,
  usePane,
  useServerRefresh,
} from '@oryh/dsh-client-frame/client'
import { useContext, useEffect, useState } from 'react'
import { useTodosApi } from './api.js'

const names: Record<string, string> = {
  todo: '待办',
  sales_quotation: '销售报价',
  purchase_request: '采购申请',
  purchase_order: '采购订单',
  sales_order: '销售订单',
  timesheet_header: '工时单',
  expense_claim: '费用单',
  quotation: '报价',
  request: '申请',
  po: '采购订单',
  order: '订单',
  header: '单据',
  claim: '费用',
  items: '明细',
  entries: '明细',
  approval_records: '审批记录',
  product: '产品',
  sku: '规格',
  adjustments: '价格调整',
  id: '编号',
  employee_id: '员工编号',
  title: '标题',
  description: '说明',
  status: '状态',
  entity_type: '关联类型',
  entity_id: '关联编号',
  quote_number: '报价编号',
  revision_no: '版本',
  currency: '币种',
  total_amount: '单据总额',
  computed_total: '明细合计',
  adjusted_total: '调整后合计',
  adjustments_total: '调整金额',
  estimated_total: '估算合计',
  unpriced_item_count: '未定价明细数',
  pending_sku_count: '未定规格明细数',
  customer_name_snapshot: '客户',
  vendor_name_snapshot: '供应商',
  quantity: '数量',
  unit_price: '单价',
  list_price: '目录价格',
  amount: '金额',
  name: '名称',
  product_name_snapshot: '产品',
  spec: '规格',
  unit: '单位',
  notes: '备注',
  task: '工作任务',
  hours: '小时',
  payment_terms: '付款条件',
  delivery_terms: '交付条件',
  quote_date: '报价日期',
  valid_until: '有效期至',
  submitted_at: '提交时间',
  created_at: '创建时间',
  updated_at: '更新时间',
  round_no: '审批轮次',
  sequence_no: '审批节点',
  action: '审批动作',
  comment: '审批意见',
  approver_id: '审批人',
  acted_at: '审批时间',
  remarks: '备注',
  source_report_text: '原始说明',
}
const label = (key: string) => {
  const [name, ...suffix] = key.split(' ')
  return [names[name!] ?? name, ...suffix].join(' ')
}
const isMetadata = (name: string) =>
  name === 'id' || name.endsWith('_id') || name === 'created_at' || name === 'updated_at'

/**
 * The linked document of the open todo, read through the same authenticated business Remote as the
 * model's read tool, and the state of the pane's link to Chat.
 *
 * Which todo is open reaches Chat through the page's context; nothing here talks to the Host.
 */
export function TodoChat({ connectionId, todoId }: { connectionId: ConnectionId; todoId: string }) {
  const sessionId = useContext(BusinessSessionContext),
    api = useTodosApi()
  const { status, error: linkError } = usePane()
  const [retry, setRetry] = useState(0),
    [document, setDocument] = useState<TodoDocument>(),
    [error, setError] = useState('')
  // The linked document may have been changed in Chat; reading it again is the same re-sync as the button.
  useServerRefresh(true, () => setRetry(n => n + 1))
  useEffect(() => {
    let alive = true
    setDocument(undefined)
    setError('')
    void api
      .todoDetail(connectionId, todoId)
      .then(d => {
        if (alive) setDocument(d)
      })
      .catch(e => {
        if (alive) setError(e instanceof Error ? e.message : '关联详情读取失败。')
      })
    return () => {
      alive = false
    }
  }, [api, connectionId, todoId, retry])
  const linked = sessionId !== undefined && status === 'synced'
  const message = !sessionId
    ? '请先在 Chat 中选择或创建一个会话。'
    : status === 'rejected'
      ? (linkError ?? 'Chat 上下文同步失败。')
      : status === 'reconnecting'
        ? '正在重新连接 Chat…'
        : '正在同步 Chat 上下文…'
  return (
    <section className="oryh-todo-chat">
      <div className="chat-context-status">
        <p role="status">
          <strong>{linked ? 'Chat 已关联当前待办' : 'Chat 上下文'}</strong>
          {!linked && <> · {message}</>}
        </p>
        <Button size="small" appearance="subtle" onClick={() => setRetry(n => n + 1)}>
          重新同步
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!document && !error && <p role="status">正在读取关联单据…</p>}
      {document && (
        <div className="surface document-detail">
          <h2>{label(document.entityType)}</h2>
          <p className="data-caption">来源：ORYH · 查询时间：{formatDateTime(document.fetchedAt)}</p>
          {document.sections
            .filter(s => s.name !== 'todo')
            .map(s => (
              <details
                key={s.name}
                open={!s.name.includes('/') || /\/(quotation|request|po|order|header|claim)$/.test(s.name)}
              >
                <summary>{s.name.split('/').map(label).join(' / ')}</summary>
                <dl className="document-fields">
                  {s.fields
                    .filter(f => !isMetadata(f.name))
                    .map(f => (
                      <div key={f.name}>
                        <dt>{label(f.name)}</dt>
                        <dd>{f.name === 'status' ? statusLabel(f.value) : formatDisplayValue(f.value)}</dd>
                      </div>
                    ))}
                </dl>
                {s.fields.some(f => isMetadata(f.name)) && (
                  <details className="document-metadata">
                    <summary>编号与系统记录</summary>
                    <dl className="document-fields">
                      {s.fields
                        .filter(f => isMetadata(f.name))
                        .map(f => (
                          <div key={f.name}>
                            <dt>{label(f.name)}</dt>
                            <dd>{formatDisplayValue(f.value)}</dd>
                          </div>
                        ))}
                    </dl>
                  </details>
                )}
              </details>
            ))}
        </div>
      )}
    </section>
  )
}
