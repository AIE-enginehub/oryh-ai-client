import { describe,it,expect,vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { OryhTimesheetRemote,TimesheetFields } from '@oryh/ai-client-timesheets'
import { TimesheetChat } from '../src/timesheet-chat.js'
import { CommandQueue } from '../src/command-queue.js'
import { SubmitReview } from '../src/submit-review.js'
/** The page's shape: what the form syncs back and what a stored proposal must look like. */
const form:TimesheetFields={period_start:'2026-09-09',period_end:'2026-09-09',source_report_text:'开发',entries:[{work_date:'2026-09-09',hours:8,work_type:'normal',project_id:'p',task:'开发',notes:''}]}
/** The tool's shape: the page form plus the name assertion the tool must make about each id. */
const proposed={...form,entries:form.entries.map(entry=>({...entry,project_name:'项目'}))}
const projects=[{id:'p',name:'项目'},{id:'q',name:'另一个项目'}]
function setup(){
 const prepare=vi.fn(),confirm=vi.fn()
 const api={timesheetList:async()=>[{id:'h',employee_id:'e',period_start:'2026-09-09',period_end:'2026-09-09',status:'draft',source_report_text:''}],timesheetQueue:async()=>[{id:'t',entity_id:'h',title:'审批',description:''}],timesheetOptions:async()=>({workTypes:[{name:'normal',title:'正常工时'}],projects,editableStates:['draft'],submitStates:['draft'],requirements:[]}),timesheetDetail:async()=>({header:{id:'h',employee_id:'e',period_start:'2026-09-09',period_end:'2026-09-09',status:'draft',source_report_text:''},entries:[{...form.entries[0],id:'line'}],approval_records:[]}),timesheetPrepare:prepare,timesheetConfirm:confirm} as unknown as OryhTimesheetRemote
 const binding={connectionId:'c' as ConnectionId,timesheetPage:'page',manager:false}
 const queue=new CommandQueue()
 const registered=new Map<string,{execute:(args:never,extra:never)=>Promise<string>}>()
 const inbox:{target:string;text:string}[]=[]
 // followup is what the Host must use: it queues AND wakes an idle driver. A bare inbox.append
 // leaves the message parked forever when nobody is mid-turn, which is the common case.
 const agent={status:'idle',inbox:{nextTurn:[] as {id:string}[],append:()=>{throw new Error('inbox.append does not wake an idle agent; use followup')}},
   id:'s',
   // A real followup lands in nextTurn until the driver claims it; the queued/reviewing split reads exactly that.
   followup:(message:{id:string;content:{text?:string}[]})=>{inbox.push({target:'followup',text:String(message.content[0]?.text??'')});agent.inbox.nextTurn.push({id:String(message.id)})}}
 // Every listener is kept, not just agent/status: a review also has to settle on agent/error.
 const listeners=new Map<string,(payload:never)=>void>()
 const emit=(name:string,payload:unknown)=>listeners.get(name)?.(payload as never)
 const onStatus=(payload:{agent:unknown})=>emit('agent/status',payload)
 const ctx={tools:{register:(tool:{name:string})=>{registered.set(tool.name,tool as never)}},effect:()=>{},agents:{get:()=>agent},
   on:(name:string,fn:(payload:never)=>void)=>{listeners.set(name,fn)}} as unknown as Context
 // The review is shared across every document kind ORYH governs with a workflow definition, so the
 // fixture builds the real one rather than a stub: its tool and listeners are what is under test.
 const reviews=new SubmitReview(ctx,queue)
 reviews.install()
 const chat=new TimesheetChat(ctx,api,async()=>binding,queue,reviews)
 chat.install()
 const state={sessionId:'s',connectionId:binding.connectionId,pageKey:'page',revision:1,manager:false,fields:form}
 return {chat,reviews,api,binding,state,prepare,confirm,queue,inbox,agent,emit,tool:(name:string)=>registered.get(name)!,
  /** Simulate the driver claiming the queued request, then the status transition it raises. */
  claimRequest:()=>{agent.inbox.nextTurn.length=0;onStatus({agent})}}
}
/** Drive microtasks until `ready`, so a staged proposal is observed rather than guessed at. */
async function until(ready:()=>boolean){
 for(let tick=0;tick<500&&!ready();tick++)await new Promise(resolve=>{setTimeout(resolve,1)})
 if(!ready())throw new Error('the chat never reached the expected state')
}
describe('timesheet suggestions',()=>{
 it('reads user fields and stages a proposal without prepare, confirm or tokens',async()=>{
  const f=setup();await f.chat.sync(f.state);expect((await f.chat.read('s')).form).toEqual(form)
  await f.chat.propose('s',1,{kind:'create',fields:proposed});const p=f.chat.pending('s')
  // The stored proposal is page-shaped: the name assertion is for validation, never for the form.
  expect(p?.action.fields).toEqual(form)
  expect(p?.action.fields?.entries[0]).not.toHaveProperty('project_name')
  expect(JSON.stringify(p)).not.toContain('token');expect(f.prepare).not.toHaveBeenCalled();expect(f.confirm).not.toHaveBeenCalled()
 })
 it('accepts incremental form filling without treating it as a savable record',async()=>{
  const f=setup();await f.chat.sync(f.state);await f.chat.propose('s',1,{kind:'create',fields:{...proposed,entries:[{...proposed.entries[0],hours:0,work_type:'',task:'先填写工作内容'}]}})
  expect((f.chat.pending('s'))?.action.fields?.entries[0]?.hours).toBe(0);expect(f.prepare).not.toHaveBeenCalled()
 })
 it('invalidates suggestions after manual edits and rejects stale revisions and pages',async()=>{
  const f=setup();await f.chat.sync(f.state);await f.chat.propose('s',1,{kind:'create',fields:proposed});await f.chat.sync({...f.state,revision:2})
  expect(f.chat.pending('s')).toBeUndefined();await expect(f.chat.propose('s',1,{kind:'create',fields:proposed})).rejects.toThrow(/版本/)
  await expect(f.chat.sync({...f.state,pageKey:'other'})).rejects.toThrow(/页面/);f.chat.clear('s');await expect(f.chat.read('s')).rejects.toThrow(/尚未同步/)
 })
 it('rejects unknown targets, guessed projects, invalid hours and approvals staged on the page',async()=>{
  const f=setup();await f.chat.sync(f.state);await expect(f.chat.read('s','foreign')).rejects.toThrow(/不在/)
  await expect(f.chat.propose('s',1,{kind:'create',fields:{...proposed,entries:[{...proposed.entries[0],hours:25}]}})).rejects.toThrow(/24/)
  await expect(f.chat.propose('s',1,{kind:'create',fields:{...proposed,entries:[{...proposed.entries[0],project_id:'foreign'}]}})).rejects.toThrow(/项目/)
  await expect(f.chat.propose('s',1,{kind:'approve',headerId:'h',todoId:'t',decision:'approved',comment:'同意'})).rejects.toThrow(/skill/)
 })
 it('rejects a project whose asserted name does not match the id it resolved to',async()=>{
  // The observed defect: a well-formed id that is not the project the user asked for. An id-only
  // check cannot see it, so the tool must state the name as a second, independent claim.
  const f=setup();await f.chat.sync(f.state)
  await expect(f.chat.propose('s',1,{kind:'create',fields:{...proposed,entries:[{...proposed.entries[0],project_id:'q'}]}}))
   .rejects.toThrow(/不一致.*另一个项目.*项目/s)
  expect(f.chat.pending('s')).toBeUndefined()
 })
 it('requires the id and the name to be given together or both left empty',async()=>{
  const f=setup();await f.chat.sync(f.state)
  await expect(f.chat.propose('s',1,{kind:'create',fields:{...proposed,entries:[{...proposed.entries[0],project_id:''}]}})).rejects.toThrow(/没有给出项目编号/)
  await expect(f.chat.propose('s',1,{kind:'create',fields:{...proposed,entries:[{...proposed.entries[0],project_name:''}]}})).rejects.toThrow(/请同时给出项目名称/)
  // Both empty is the documented way to record no project at all.
  await f.chat.propose('s',1,{kind:'create',fields:{...proposed,entries:[{...proposed.entries[0],project_id:'',project_name:''}]}})
  expect(f.chat.pending('s')?.action.fields?.entries[0]?.project_id).toBe('')
 })
 it('flags duplicate project names so the model has to ask which one',async()=>{
  const f=setup();await f.chat.sync(f.state)
  f.api.timesheetOptions=async()=>({workTypes:[{name:'normal',title:'正常工时'}],projects:[{id:'p',name:'项目'},{id:'q',name:'项目'}],editableStates:['draft'],submitStates:['draft'],requirements:[]})
  const read=await f.chat.read('s')
  expect(read.ambiguousProjects).toEqual(['项目'])
  // Only the duplicated name is called out; a tenant can have many unique projects alongside it.
  expect(read.notice).toContain('“项目”')
  expect(read.notice).toContain('不必反问')
 })
 it('reports the page content in the receipt rather than echoing the requested fields',async()=>{
  const f=setup();await f.chat.sync(f.state)
  const call=f.tool('oryh_timesheet_propose').execute({revision:1,action:{kind:'create',fields:proposed}} as never,{agent:{id:'s'},signal:new AbortController().signal} as never)
  await until(()=>f.chat.pending('s')!==undefined)
  // The page ends up holding a different project and fewer hours than were requested.
  await f.chat.sync({...f.state,revision:2,fields:{...form,entries:[{...form.entries[0]!,project_id:'q',hours:3}]}})
  const receipt=JSON.parse(await call)
  expect(receipt.applied.entries[0].project_id).toBe('q')
  expect(receipt.applied.entries[0].project_name).toBe('另一个项目')
  expect(receipt.applied.total_hours).toBe(3)
  expect(receipt.message).toContain('其他修改')
 })
 it('names the applied project and totals when the page matches the request',async()=>{
  const f=setup();await f.chat.sync(f.state)
  const call=f.tool('oryh_timesheet_propose').execute({revision:1,action:{kind:'create',fields:proposed}} as never,{agent:{id:'s'},signal:new AbortController().signal} as never)
  await until(()=>f.chat.pending('s')!==undefined)
  await f.chat.sync({...f.state,revision:2,fields:form})
  const receipt=JSON.parse(await call)
  expect(receipt.message).toContain('已更新')
  expect(receipt.applied.entries[0].project_name).toBe('项目')
  expect(receipt.applied.total_hours).toBe(8)
  expect(receipt.applied.daily_hours).toEqual([{work_date:'2026-09-09',hours:8}])
 })
 it('asks the agent to review a submission through its inbox, without starting a competing turn',async()=>{
  const f=setup();await f.chat.sync(f.state)
  f.agent.status='running'
  await f.chat.reviewStart('s','h')
  // followup queues behind a running turn and still wakes an idle one; append does neither.
  expect(f.inbox).toHaveLength(1)
  expect(f.inbox[0]?.target).toBe('followup')
  expect(f.inbox[0]?.text).toContain('提交动作触发')
  expect(f.inbox[0]?.text).toContain('h')
  // The request is still pending in the inbox, so the page shows it queued rather than running.
  expect(f.reviews.state('s')).toEqual({objectType:'timesheet_header',documentId:'h',label:'工时单',status:'queued'})
 })
 it('settles a review whose turn died, reporting why',async()=>{
  const f=setup();await f.chat.sync(f.state)
  await f.chat.reviewStart('s','h')
  f.claimRequest()
  expect(f.reviews.state('s')?.status).toBe('reviewing')

  // The turn fails (a model quota error here) and then the agent goes idle with nothing reported.
  // Before this, the page waited on a verdict that was never coming — and with submitting gated on
  // it, that is a dead end rather than a slow path.
  f.emit('agent/error',{agent:f.agent,error:new Error('Allocated quota exceeded')})
  f.emit('agent/status',{agent:f.agent,status:'idle'})
  expect(f.reviews.state('s')).toEqual({objectType:'timesheet_header',documentId:'h',label:'工时单',status:'unavailable',message:'Allocated quota exceeded'})

  // A verdict arriving late for a settled review is ignored rather than reviving it.
  const late=await f.tool('oryh_review_result').execute({verdict:'passed',message:''} as never,{agent:{id:'s'},signal:new AbortController().signal} as never)
  expect(late).toContain('已结束')
  expect(f.reviews.state('s')?.status).toBe('unavailable')
  // And an unavailable review must not open the submit gate.
  expect(()=>f.reviews.assertPassed('timesheet_header','h','s')).toThrow(/未经/)
 })
 it('lets only a passed verdict through the submit gate',async()=>{
  const f=setup();await f.chat.sync(f.state)
  const submit={kind:'submit',headerId:'h'},exec={agent:{id:'s'},signal:new AbortController().signal}

  // No review at all is not a free pass: it is the state anyone would reach by closing the session.
  expect(()=>f.reviews.assertPassed('timesheet_header',submit.headerId,'s')).toThrow(/未经/)
  await f.chat.reviewStart('s','h')
  expect(()=>f.reviews.assertPassed('timesheet_header',submit.headerId,'s')).toThrow(/尚未完成/)

  await f.tool('oryh_review_result').execute({verdict:'flagged',message:'本周合计 24 小时，少于 30 小时'} as never,exec as never)
  expect(()=>f.reviews.assertPassed('timesheet_header',submit.headerId,'s')).toThrow(/少于 30 小时/)
  // Nothing about a flagged verdict may be worked around by dropping the session id either.
  expect(()=>f.reviews.assertPassed('timesheet_header',submit.headerId,undefined)).toThrow(/未经/)

  await f.reviews.clear('s');await f.chat.reviewStart('s','h')
  await f.tool('oryh_review_result').execute({verdict:'passed',message:''} as never,exec as never)
  expect(()=>f.reviews.assertPassed('timesheet_header',submit.headerId,'s')).not.toThrow()
  // A verdict about a different timesheet must not clear this one.
  expect(()=>f.reviews.assertPassed('timesheet_header','other','s')).toThrow(/未经/)
 })
 it('moves from queued to reviewing when the agent claims the request',async()=>{
  const f=setup();await f.chat.sync(f.state)
  await f.chat.reviewStart('s','h')
  expect(f.reviews.state('s')?.status).toBe('queued')
  // The review's own first step is what marks it running: agent/status fires before the inbox
  // drains, so the read tool is the dependable signal.
  await f.tool('oryh_timesheet_read').execute({headerId:''} as never,{agent:{id:'s'},signal:new AbortController().signal} as never)
  expect(f.reviews.state('s')?.status).toBe('reviewing')
  // A settled verdict must not be dragged back by a later status transition.
  await f.tool('oryh_review_result').execute({verdict:'passed',message:''} as never,{agent:{id:'s'},signal:new AbortController().signal} as never)
  // A settled verdict must not be dragged back by a later read.
  await f.tool('oryh_timesheet_read').execute({headerId:''} as never,{agent:{id:'s'},signal:new AbortController().signal} as never)
  expect(f.reviews.state('s')?.status).toBe('passed')
 })
 it('publishes the agent verdict and ignores one that arrives for no live review',async()=>{
  const f=setup();await f.chat.sync(f.state)
  const report=f.tool('oryh_review_result')
  const extra={agent:{id:'s'},signal:new AbortController().signal} as never
  // No review running: a stray verdict must not appear against the next submission.
  expect(await report.execute({verdict:'passed',message:''} as never,extra)).toContain('没有待回报')
  expect(f.reviews.state('s')).toBeUndefined()
  await f.chat.reviewStart('s','h')
  await report.execute({verdict:'flagged',message:'本周合计 36 小时，少于要求的 40 小时。'} as never,extra)
  expect(f.reviews.state('s')?.status).toBe('flagged')
  expect(f.reviews.state('s')?.message).toBe('本周合计 36 小时，少于要求的 40 小时。')
  // A second verdict for a settled review is late, not a correction.
  expect(await report.execute({verdict:'passed',message:''} as never,extra)).toContain('已结束')
  expect(f.reviews.state('s')?.status).toBe('flagged')
 })
 it('drops the review when it is skipped or the page is left',async()=>{
  const f=setup();await f.chat.sync(f.state)
  await f.chat.reviewStart('s','h');expect(f.reviews.state('s')).toBeDefined()
  f.reviews.clear('s');expect(f.reviews.state('s')).toBeUndefined()
  await f.chat.reviewStart('s','h');f.chat.clear('s')
  expect(f.reviews.state('s')).toBeUndefined()
 })
 it('leaves submitting and approving to the agent in the conversation instead of staging them on the page',async()=>{
  // ADR-0010: the agent writes through ORYH's skills and confirms in the conversation, so nothing
  // here may route a submit or an approval to the page's confirmation dialog.
  const f=setup();await f.chat.sync(f.state)
  await expect(f.chat.propose('s',1,{kind:'submit',headerId:'h'})).rejects.toThrow(/skill/)
  f.binding.manager=true;await f.chat.sync({...f.state,manager:true})
  await expect(f.chat.propose('s',1,{kind:'approve',headerId:'h',todoId:'t',decision:'approved',comment:'同意'})).rejects.toThrow(/skill/)
  // The approval page has no form to fill at all.
  await expect(f.chat.propose('s',1,{kind:'create',fields:proposed})).rejects.toThrow(/审批页面没有可填写的表单/)
  expect(f.chat.pending('s')).toBeUndefined();expect(f.prepare).not.toHaveBeenCalled();expect(f.confirm).not.toHaveBeenCalled()
 })
 it('discards in-flight reads when the user leaves the page',async()=>{
  const f=setup();await f.chat.sync(f.state);let release!:()=>void
  const list=f.api.timesheetList;f.api.timesheetList=async id=>{await new Promise<void>(r=>{release=r});return list(id)}
  const pending=f.chat.read('s');await new Promise(r=>setTimeout(r,0));f.chat.clear('s');release();await expect(pending).rejects.toThrow(/离开/)
 })
})

describe('aggregate edit suggestions',()=>{
 it('preserves existing ids and only stages a draft, refusing duplicate or foreign ids',async()=>{
  const f=setup()
  f.api.timesheetDetail=async()=>({canEdit:true,header:{id:'h',employee_id:'e',period_start:'2026-09-09',period_end:'2026-09-09',status:'draft',source_report_text:''},entries:[{...form.entries[0]!,id:'line',projectName:'项目',client:''}],approval_records:[]})
  await f.chat.sync({...f.state,headerId:'h'})
  const fields={...proposed,entries:[{...proposed.entries[0]!,id:'line',hours:6},{...proposed.entries[0]!,hours:2}]}
  await f.chat.propose('s',1,{kind:'update',headerId:'h',fields})
  expect(f.chat.pending('s')?.action.fields?.entries.map(l=>l.id)).toEqual(['line',undefined])
  expect(f.prepare).not.toHaveBeenCalled();expect(f.confirm).not.toHaveBeenCalled()
  await expect(f.chat.propose('s',1,{kind:'update',headerId:'h',fields:{...fields,entries:[{...fields.entries[0],id:'foreign'}]}})).rejects.toThrow(/编号/)
  await expect(f.chat.propose('s',1,{kind:'update',headerId:'h',fields:{...fields,entries:[fields.entries[0],fields.entries[0]]}})).rejects.toThrow(/编号/)
 })
})
