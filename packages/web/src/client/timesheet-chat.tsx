import { useContext, useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { TimesheetAction, TimesheetFields } from '@oryh/ai-client-timesheets'
import type { TimesheetChatProposal } from '@oryh/dsh-host/types'
import { BusinessSessionContext } from './todo-chat.js'
import { useCommands } from './command-stream.js'
import { useOryhRemote } from './remote.js'
/** Chat fills the form on screen; saving, submitting and approving happen in the conversation itself (ADR-0010). */
const titles:Partial<Record<TimesheetAction['kind'],string>>={update:'修改整张工时表单',create:'填写工时表单','add-line':'添加工时明细','edit-line':'修改工时明细','delete-line':'删除工时明细'}
export function TimesheetChat({connectionId,manager,fields,headerId,todoId,navigationId,navigationReady=true,localEdits,busy,dirty,onApply}:{connectionId:ConnectionId;manager:boolean;fields?:TimesheetFields;headerId?:string;todoId?:string;navigationId?:string;navigationReady?:boolean;localEdits:string;busy:boolean;dirty:boolean;onApply:(action:TimesheetAction)=>void}){
  const api=useOryhRemote(),sessionId=useContext(BusinessSessionContext)
  const [pageKey]=useState(()=>crypto.randomUUID()),[ready,setReady]=useState(false),[message,setMessage]=useState(''),[retry,setRetry]=useState(0),[proposal,setProposal]=useState<TimesheetChatProposal>()
  const apply=useRef(onApply),isBusy=useRef(busy);apply.current=onApply;isBusy.current=busy
  const version=useRef({json:'',revision:0}),seen=useRef('')
  const json=JSON.stringify({fields,headerId,todoId,localEdits,navigationId,navigationReady})
  if(version.current.json!==json)version.current={json,revision:version.current.revision+1}
  const revision=version.current.revision
  useEffect(()=>{
    let live=true;setReady(false);setProposal(undefined)
    if(!sessionId){setMessage('请在 Chat 中选择或新建会话，即可通过 Chat 填写工时。');return}
    setMessage('正在关联工时页面…')
    void api.chatSelect({sessionId,connectionId,timesheetPage:pageKey,manager,...(navigationId?{navigationId}:{})}).then(()=>{if(live)setReady(true)}).catch(e=>{if(live)setMessage(e instanceof Error?e.message:'Chat 关联失败')})
    return()=>{live=false;void api.chatClear(sessionId).catch(()=>{})}
  },[api,sessionId,connectionId,pageKey,manager,retry,navigationId])
  useEffect(()=>{
    if(!ready||!sessionId)return
    let live=true
    setProposal(undefined)
    const state={sessionId,connectionId,pageKey,revision,manager,localEdits,...(navigationId&&navigationReady?{navigationId}:{}),...(fields?{fields}:{}),...(headerId?{headerId}:{}),...(todoId?{todoId}:{})}
    void api.timesheetChatSync(state).then(()=>{if(live)setMessage('Chat 已关联')}).catch(e=>{if(live)setMessage(e instanceof Error?e.message:'Chat 同步失败')})
    return()=>{live=false}
  },[api,ready,sessionId,connectionId,pageKey,revision,manager])
  const stream=useCommands(),suggestion=stream.commands.timesheet
  useEffect(()=>{
    if(!ready||!sessionId||!suggestion||suggestion.revision!==version.current.revision||suggestion.id===seen.current)return
    if(['create','update'].includes(suggestion.action.kind)&&!isBusy.current){seen.current=suggestion.id;apply.current(suggestion.action);setMessage('Chat 已更新未保存表单，可继续描述要修改的内容。')}
    else setProposal(suggestion)
  },[ready,sessionId,suggestion])
  useEffect(()=>{if(ready&&stream.error!==undefined)setMessage(stream.error)},[ready,stream.error])
  const p=proposal?.revision===revision?proposal:undefined
  return <div className="oryh-timesheet-chat"><div className="chat-context-status"><p role="status">{message}</p><Button size="small" appearance="subtle" disabled={!sessionId||busy} onClick={()=>setRetry(n=>n+1)}>重新同步</Button></div>{p&&<section className="surface"><h2>Chat 建议 · {titles[p.action.kind]??'修改工时表单'}</h2><p>这是对中间栏表单的修改建议，应用后仍需在页面保存。</p>{p.action.fields&&<p>{p.action.fields.period_start} — {p.action.fields.period_end}<br/>{p.action.fields.source_report_text}</p>}{(p.action.fields||p.action.line)&&<div className="table-scroll"><table><thead><tr><th>日期</th><th>小时</th><th>工作任务</th><th>备注</th></tr></thead><tbody>{(p.action.fields?.entries??[p.action.line!]).map((l,i)=><tr key={i}><td>{l.work_date}</td><td>{l.hours}</td><td>{l.task}</td><td>{l.notes}</td></tr>)}</tbody></table></div>}{p.action.headerId&&<p>工时编号：{p.action.headerId}</p>}<div className="toolbar"><Button appearance="primary" disabled={busy} onClick={()=>{seen.current=p.id;setProposal(undefined);onApply(p.action)}}>{['create','update'].includes(p.action.kind)&&dirty?'替换当前表单内容':'应用到工时表单'}</Button><Button disabled={busy} onClick={()=>{seen.current=p.id;setProposal(undefined)}}>忽略建议</Button></div>{dirty&&['create','update'].includes(p.action.kind)&&<p>当前有未保存修改；应用这条建议会替换当前表单内容。</p>}</section>}</div>
}
