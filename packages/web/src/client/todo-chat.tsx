import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { TodoDocument } from '@oryh/ai-client-todos'
import { useCommands, useServerRefresh } from './command-stream.js'
import { useOryhRemote } from './remote.js'
import { formatDateTime, formatDisplayValue } from './list-kit.js'
import { statusLabel } from './status-words.js'
export const BusinessSessionContext=createContext<string|undefined>(undefined)
const names:Record<string,string>={todo:'待办',sales_quotation:'销售报价',purchase_request:'采购申请',purchase_order:'采购订单',sales_order:'销售订单',timesheet_header:'工时单',expense_claim:'费用单',quotation:'报价',request:'申请',po:'采购订单',order:'订单',header:'单据',claim:'费用',items:'明细',entries:'明细',approval_records:'审批记录',product:'产品',sku:'规格',adjustments:'价格调整',id:'编号',employee_id:'员工编号',title:'标题',description:'说明',status:'状态',entity_type:'关联类型',entity_id:'关联编号',quote_number:'报价编号',revision_no:'版本',currency:'币种',total_amount:'单据总额',computed_total:'明细合计',adjusted_total:'调整后合计',adjustments_total:'调整金额',estimated_total:'估算合计',unpriced_item_count:'未定价明细数',pending_sku_count:'未定规格明细数',customer_name_snapshot:'客户',vendor_name_snapshot:'供应商',quantity:'数量',unit_price:'单价',list_price:'目录价格',amount:'金额',name:'名称',product_name_snapshot:'产品',spec:'规格',unit:'单位',notes:'备注',task:'工作任务',hours:'小时',payment_terms:'付款条件',delivery_terms:'交付条件',quote_date:'报价日期',valid_until:'有效期至',submitted_at:'提交时间',created_at:'创建时间',updated_at:'更新时间',round_no:'审批轮次',sequence_no:'审批节点',action:'审批动作',comment:'审批意见',approver_id:'审批人',acted_at:'审批时间',remarks:'备注',source_report_text:'原始说明'}
const label=(key:string)=>{const [name,...suffix]=key.split(' ');return [names[name!]??name,...suffix].join(' ')}
/** Selection and detail travel through the same authenticated business Remote as the model's read tool. */
export function TodoChat({connectionId,todoId,visibleTodos=[],listContext='',navigationId,onOpen}:{connectionId:ConnectionId;todoId?:string;visibleTodos?:{id:string;title:string}[];listContext?:string;navigationId?:string;onOpen?:(id:string,navigationId:string)=>void}){
  const sessionId=useContext(BusinessSessionContext),api=useOryhRemote()
  const listJson=JSON.stringify({visibleTodos,listContext}),listRevision=useMemo(()=>crypto.randomUUID(),[listJson])
  const openCallback=useRef(onOpen);openCallback.current=onOpen
  const [message,setMessage]=useState(''),[ready,setReady]=useState(false),[retry,setRetry]=useState(0),[document,setDocument]=useState<TodoDocument>(),[error,setError]=useState('')
  // The linked document may have been changed in Chat; reading it again is the same re-sync as the button.
  useServerRefresh(true,()=>setRetry(n=>n+1))
  useEffect(()=>{
    let alive=true
    setReady(false);setDocument(undefined);setError('');setMessage(sessionId?(todoId?'正在同步 Chat 上下文…':'请打开一条待办后询问 Chat。'):'请先在 Chat 中选择或创建一个会话。')
    if(sessionId)void api.chatSelect({sessionId,connectionId,...(todoId?{todoId,...(navigationId?{navigationId}:{})}:{visibleTodos,listRevision})}).then(r=>{if(alive){setReady(r.ready);setMessage(r.message);if(r.document)setDocument(r.document)}}).catch(e=>{if(alive)setMessage(e instanceof Error?e.message:'Chat 上下文同步失败。')})
    if(todoId&&!sessionId)void api.todoDetail(connectionId,todoId).then(d=>{if(alive)setDocument(d)}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'关联详情读取失败。')})
    return()=>{alive=false;if(sessionId)void api.chatClear(sessionId).catch(()=>{})}
  },[api,connectionId,todoId,sessionId,retry,listRevision,navigationId])
  const command=useCommands().commands.navigation
  useEffect(()=>{
    if(!sessionId||todoId||!ready)return
    if(command?.target==='todo'&&command.todoId&&command.listRevision===listRevision&&visibleTodos.some(t=>t.id===command.todoId))openCallback.current?.(command.todoId,command.id)
  },[sessionId,todoId,ready,listRevision,command])
  if (!todoId) return null
  return <section className="oryh-todo-chat">
    <div className="chat-context-status"><p role="status"><strong>{ready?'Chat 已关联当前待办':'Chat 上下文'}</strong>{!ready && <> · {message}</>}</p><Button size="small" appearance="subtle" disabled={!sessionId} onClick={()=>setRetry(n=>n+1)}>重新同步</Button></div>
    {error&&<p role="alert">{error}</p>}
    {!document&&!error&&<p role="status">正在读取关联单据…</p>}
    {document&&<div className="surface document-detail"><h2>{label(document.entityType)}</h2><p className="data-caption">来源：ORYH · 查询时间：{formatDateTime(document.fetchedAt)}</p>
      {document.sections.filter(s=>s.name!=='todo').map(s=><details key={s.name} open={!s.name.includes('/') || /\/(quotation|request|po|order|header|claim)$/.test(s.name)}><summary>{s.name.split('/').map(label).join(' / ')}</summary><dl className="document-fields">{s.fields.filter(f=>f.name!=='id'&&!f.name.endsWith('_id')&&f.name!=='created_at'&&f.name!=='updated_at').map(f=><div key={f.name}><dt>{label(f.name)}</dt><dd>{f.name==='status'?statusLabel(f.value):formatDisplayValue(f.value)}</dd></div>)}</dl>{s.fields.some(f=>f.name==='id'||f.name.endsWith('_id')||f.name==='created_at'||f.name==='updated_at')&&<details className="document-metadata"><summary>编号与系统记录</summary><dl className="document-fields">{s.fields.filter(f=>f.name==='id'||f.name.endsWith('_id')||f.name==='created_at'||f.name==='updated_at').map(f=><div key={f.name}><dt>{label(f.name)}</dt><dd>{formatDisplayValue(f.value)}</dd></div>)}</dl></details>}</details>)}
    </div>}
  </section>
}
