import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { OryhClientError, type ConnectionId } from '@oryh/ai-client-foundation'
import { validateTimesheet, type OryhTimesheetRemote, type TimesheetAction, type TimesheetFields, type TimesheetLine } from '@oryh/ai-client-timesheets'
import type { TimesheetChatState, TimesheetChatProposal } from './types.js'
import { TIMESHEET_OBJECT_TYPE } from '@oryh/ai-client-timesheets/contracts'
import type { SubmitReview } from './submit-review.js'
import type { CommandQueue } from './command-queue.js'
const line=z.object({id:z.string().optional(),work_date:z.string(),hours:z.number(),work_type:z.string(),project_id:z.string(),project_name:z.string(),task:z.string().max(200),notes:z.string().max(2000)}).strict()
const fields=z.object({period_start:z.string(),period_end:z.string(),source_report_text:z.string().max(10000),entries:z.array(line).min(1).max(100)}).strict()
/**
 * The page's own shape. `project_name` is the tool's assertion about its id resolution, not a form
 * field, so it must not reach the page; this schema strips it from both sides of the receipt
 * comparison, which would otherwise compare a page snapshot against a differently-shaped request.
 */
const pageFields=z.object({period_start:z.string(),period_end:z.string(),source_report_text:z.string(),entries:z.array(z.object({id:z.string().optional(),work_date:z.string(),hours:z.number(),work_type:z.string(),project_id:z.string(),task:z.string(),notes:z.string()}))})
const lineSnapshot=({project_name:_asserted,id,...entry}:z.infer<typeof line>):TimesheetLine=>({...entry,...(id?{id}:{})})
const formSnapshot=(value:z.infer<typeof fields>):TimesheetFields=>({period_start:value.period_start,period_end:value.period_end,source_report_text:value.source_report_text,entries:value.entries.map(lineSnapshot)})
/** Drop the tool's name assertions so only page-shaped data is stored or published. */
function pageAction(value:z.infer<typeof actionSchema>):TimesheetAction{
  if(value.kind==='update')return {kind:value.kind,headerId:value.headerId,fields:formSnapshot(value.fields)}
  if(value.kind==='create')return {kind:value.kind,fields:formSnapshot(value.fields)}
  if(value.kind==='add-line')return {kind:value.kind,headerId:value.headerId,line:lineSnapshot(value.line)}
  if(value.kind==='edit-line')return {kind:value.kind,headerId:value.headerId,entryId:value.entryId,line:lineSnapshot(value.line)}
  return value
}
/**
 * What the page actually holds, read from the synced form rather than echoed from the request.
 *
 * A content-free receipt let the model restate its own intent unchallenged, so a wrong project
 * read back as a confident success. Naming the project and the hours the page really has is what
 * makes that contradiction visible in the trajectory and to the user.
 * @param form - the form snapshot the page synced back.
 * @param projects - currently available projects, used to name the ids the page holds.
 * @returns the period, per-day and total hours, and each entry with its project id and name.
 */
function appliedSummary(form:TimesheetFields,projects:readonly {id:string;name:string}[]){
  const daily=new Map<string,number>()
  for(const l of form.entries)daily.set(l.work_date,(daily.get(l.work_date)??0)+l.hours)
  return {
    period_start:form.period_start,period_end:form.period_end,
    total_hours:form.entries.reduce((sum,l)=>sum+l.hours,0),
    daily_hours:[...daily].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([work_date,hours])=>({work_date,hours})),
    entries:form.entries.map(l=>({work_date:l.work_date,hours:l.hours,work_type:l.work_type,project_id:l.project_id,
      project_name:l.project_id?projects.find(p=>p.id===l.project_id)?.name??'（不在当前可用项目中）':'',task:l.task})),
  }
}
const actionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('create'),fields}).strict(),
  z.object({kind:z.literal('update'),headerId:z.string(),fields}).strict(),
  z.object({kind:z.literal('add-line'),headerId:z.string(),line}).strict(),
  z.object({kind:z.literal('edit-line'),headerId:z.string(),entryId:z.string(),line}).strict(),
  z.object({kind:z.literal('delete-line'),headerId:z.string(),entryId:z.string()}).strict(),
])
interface PageBinding { connectionId:ConnectionId; timesheetPage?:string; manager?:boolean }
const lineSpec={type:'object',additionalProperties:false,properties:{id:{type:'string',description:'已有明细保留原编号；新增明细不传'},work_date:{type:'string',required:true},hours:{type:'number',required:true},work_type:{type:'string',required:true},project_id:{type:'string',required:true,description:'不关联项目时必须为空字符串'},project_name:{type:'string',required:true,description:'project_id 对应项目的名称，逐字取自 read 返回的 projects；与编号不一致会被拒绝。不关联项目时必须为空字符串'},task:{type:'string',required:true},notes:{type:'string',required:true}}} as const
const fieldsSpec={type:'object',additionalProperties:false,properties:{period_start:{type:'string',required:true},period_end:{type:'string',required:true},source_report_text:{type:'string',required:true},entries:{type:'array',required:true,items:lineSpec}}} as const
const actionSpec={type:'object',required:true,additionalProperties:false,properties:{kind:{type:'string',required:true,enum:['create','update','add-line','edit-line','delete-line']},fields:fieldsSpec,headerId:{type:'string'},entryId:{type:'string'},line:lineSpec}} as const
const fail=(text:string)=>new OryhClientError(text,'request-failed')
/**
 * Fills the timesheet form a person is editing in the business pane.
 *
 * Saving, submitting and approving are not here: the agent does those itself, through ORYH's skills,
 * confirming in the conversation (ADR-0010). What stays is helping with a form that is on screen and
 * unsaved, so no prepare/confirm method or confirmation token reaches a tool.
 */
export class TimesheetChat {
  private states=new Map<string,TimesheetChatState>()
  private proposals=new Map<string,TimesheetChatProposal>()
  /** The unsaved form as the agent last read or filled it, serialized as the page synced it. */
  private seen=new Map<string,string>()
  constructor(private ctx:Context,private api:OryhTimesheetRemote|undefined,private binding:(id:string,verify?:boolean,write?:boolean)=>Promise<PageBinding>,private queue:CommandQueue,private reviews:SubmitReview){}
  current(id:string){return this.states.get(id)}
  /** The staged suggestion the command stream publishes for this session. */
  pending(id:string){return this.proposals.get(id)}
  clear(id:string){this.states.delete(id);this.proposals.delete(id);this.seen.delete(id);this.reviews.clear(id);this.queue.changed(id)}
  /**
   * The unsaved form the agent may discard to open another timesheet, serialized as the page holds it.
   *
   * Only a form the agent has itself seen in full — read, or filled and confirmed applied — and that
   * the person has not changed since, with no line being edited: once the agent has written that
   * content to ORYH in Chat, the draft is a stale copy, while anything the person typed afterwards is
   * theirs and still protected.
   * @param id - session whose page holds the form.
   * @returns the form as synced, or undefined when the page holds no form.
   * @throws when the page changed after the agent last saw its form.
   */
  discardableForm(id:string):string|undefined{
    const state=this.states.get(id)
    if(!state?.fields)return undefined
    const form=JSON.stringify(state.fields)
    let editing=false
    if(state.localEdits)try{editing=(JSON.parse(state.localEdits) as {editing?:unknown}).editing!==undefined}catch{editing=true}
    if(this.seen.get(id)!==form||editing)throw fail('中间栏的未保存表单在你上次读取或填写之后被用户改动过，或有明细正在编辑，不能替换。请告诉用户在页面保存或放弃后，再打开工时。')
    return form
  }
  /**
   * Ask the agent to check this timesheet against the enterprise norms before submitting.
   *
   * Only the page binding and the write permission are checked here; the review itself is generic
   * (docs/22), because every ORYH document governed by a workflow definition needs the same gate.
   * @param id - session whose agent performs the review.
   * @param headerId - timesheet being submitted; a verdict for any other document is ignored.
   */
  async reviewStart(id:string,headerId:string):Promise<void>{
    await this.binding(id,true,true)
    this.reviews.start(id,{objectType:TIMESHEET_OBJECT_TYPE,documentId:headerId,label:'工时单',read:'先用 oryh_timesheet_read 读取实际内容'})
  }
  async sync(state:TimesheetChatState):Promise<void>{
    const b=await this.binding(state.sessionId,false)
    if(b.connectionId!==state.connectionId||b.timesheetPage!==state.pageKey||Boolean(b.manager)!==state.manager)throw fail('工时页面已改变，请重新关联。')
    const old=this.states.get(state.sessionId)
    if(old&&old.pageKey===state.pageKey&&old.revision>state.revision)return
    if(!old||old.revision!==state.revision)this.proposals.delete(state.sessionId)
    this.states.set(state.sessionId,structuredClone(state))
    this.queue.settle(state.sessionId)
  }
  private async page(id:string){
    const b=await this.binding(id),state=this.states.get(id)
    if(!state||b.timesheetPage!==state.pageKey||b.connectionId!==state.connectionId||!this.api)throw fail('工时表单尚未同步，请等待 Chat 已关联后重试。')
    return {state,api:this.api}
  }
  private check(id:string,s:TimesheetChatState){if(this.states.get(id)!==s)throw fail('用户已修改表单或离开页面，请重新读取后再建议。')}
  async read(id:string,headerId=''){
    const {state:s,api}=await this.page(id)
    const [options,records]=await Promise.all([api.timesheetOptions(s.connectionId),s.manager?api.timesheetQueue(s.connectionId):api.timesheetList(s.connectionId)])
    const target=headerId||s.headerId
    const todo=s.manager?records.find(r=>'entity_id'in r&&r.entity_id===target):undefined
    if(target&&!records.some(r=>('entity_id'in r?r.entity_id:r.id)===target))throw fail('该工时不在当前员工的工时或审批队列中。')
    const detail=target?await api.timesheetDetail(s.connectionId,target,todo?.id):undefined
    this.check(id,s)
    if(s.fields)this.seen.set(id,JSON.stringify(s.fields))
    // Duplicate names cannot be resolved from a name alone, and the id/name pairing cannot catch a
    // wrong pick between two projects that share one. Naming them forces the ambiguity to the user.
    const counts=new Map<string,number>()
    for(const p of options.projects)counts.set(p.name,(counts.get(p.name)??0)+1)
    const ambiguousProjects=[...counts].filter(([,count])=>count>1).map(([name])=>name)
    return {revision:s.revision,manager:s.manager,today:new Date().toLocaleDateString('en-CA'),options,ambiguousProjects,records,detail,form:s.fields,localEdits:s.localEdits,pendingSuggestion:this.proposals.get(id)?.action,notice:'form 是中间栏上未保存的表单内容，不代表服务端已保存。'+(ambiguousProjects.length?`注意：名称“${ambiguousProjects.join('”“')}”各自对应多个不同项目；只有当用户要的正是其中之一时才必须先反问是哪一个，其余项目名称唯一，不必反问。`:'')}
  }
  async propose(id:string,revision:number,input:unknown):Promise<{message:string;proposalId:string;projects:{id:string;name:string}[]}>{
    await this.binding(id,true,true)
    const {state:s,api}=await this.page(id)
    if(s.revision!==revision)throw fail('表单版本已改变，请重新读取。')
    // Submitting and approving are the agent's own writes through skills (ADR-0010), not a form fill,
    // so a model still reaching for them here is told where they went instead of a schema error.
    const kind=input!==null&&typeof input==='object'?(input as {kind?:unknown}).kind:undefined
    if(kind==='submit'||kind==='approve')throw fail('提交和审批不经过中间栏表单：请按 ORYH 的工时或审批 skill 在对话里完成，写入前在对话里确认一次。')
    const parsed=actionSchema.safeParse(input)
    if(!parsed.success)throw fail('工时建议格式无效：'+parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join('; '))
    const action:TimesheetAction=pageAction(parsed.data)
    if(s.manager)throw fail('工时审批页面没有可填写的表单。审批请按 ORYH 的审批 skill 在对话里完成。')
    const data=await this.read(id,action.headerId)
    if(action.kind==='create'||action.kind==='update'){
      const daily=new Map<string,number>()
      for(const l of action.fields!.entries){
        if(l.hours<0||l.hours>24)throw fail('每天工时不能超过 24 小时，也不能为负数。')
        daily.set(l.work_date,(daily.get(l.work_date)??0)+l.hours)
      }
      if([...daily.values()].some(h=>h>24))throw fail('每天合计不能超过 24 小时。')
    }
    if(['update','add-line','edit-line','delete-line'].includes(action.kind) && (!data.detail?.canEdit || s.headerId!==action.headerId))throw fail('请先打开允许编辑的本人工时。')
    if(action.kind==='update'){
      const ids=action.fields!.entries.flatMap(l=>l.id?[l.id]:[])
      if(new Set(ids).size!==ids.length||ids.some(id=>!data.detail!.entries.some(l=>l.id===id)))throw fail('已有明细编号必须保留且不能重复；新明细不传编号。')
    }
    if(action.line){const d=data.detail!;const entries=action.kind==='edit-line'?d.entries.map(e=>e.id===action.entryId?action.line!:e):[...d.entries,action.line];validateTimesheet({...d.header,entries})}
    if(action.kind==='edit-line'||action.kind==='delete-line')if(!data.detail?.entries.some(e=>e.id===action.entryId))throw fail('明细不属于这张工时单。')
    if(['update','add-line','edit-line','delete-line'].includes(action.kind)&&!data.options.editableStates.includes(data.detail!.header.status))throw fail('当前单据不允许修改明细。')
    const asserted=(parsed.data.kind==='create'||parsed.data.kind==='update')?parsed.data.fields.entries:('line' in parsed.data?[parsed.data.line]:[])
    for(const l of asserted){
      if((l.work_type||!['create','update'].includes(action.kind))&&!data.options.workTypes.some(o=>o.name===l.work_type))throw fail('请选择企业已配置的工时类型。')
      const named=l.project_name.trim()
      if(!l.project_id){
        if(named)throw fail(`明细声明了项目“${named}”却没有给出项目编号。要关联项目必须同时给出编号与名称；不关联项目时两者都留空。`)
        continue
      }
      const project=data.options.projects.find(o=>o.id===l.project_id)
      if(!project)throw fail('请选择当前可用项目，不要猜测编号。')
      // The name is a second, independent statement of the same choice. An id-only check cannot
      // tell a correctly-formed id from the one the user actually asked for; a mismatch here is
      // the resolution error itself, surfaced before it reaches the form.
      if(!named)throw fail(`请同时给出项目名称以核对编号：编号 ${l.project_id} 对应“${project.name}”。`)
      if(named!==project.name)throw fail(`项目编号与名称不一致：编号 ${l.project_id} 实际是“${project.name}”，建议里写的是“${named}”。请重新确认用户要求的是哪个项目，必要时先反问，不要自行选择。`)
    }
    this.check(id,s)
    const proposal={id:randomUUID(),revision,action}
    this.proposals.set(id,proposal)
    this.queue.changed(id)
    return {message:'已发送到中间栏未保存的工时表单，尚未保存到服务端。',proposalId:proposal.id,projects:data.options.projects}
  }
  install(){
    const output={schema:{type:'string' as const},render:(_a:unknown,value:string)=>[{type:'text' as const,text:value}]}
    this.ctx.tools.register(defineTool({name:'oryh_timesheet_read',description:'读取当前工时菜单的表单版本、未保存表单、本人工时或经理审批队列、企业工时类型和项目。headerId 为空读取当前页面；非空只可查询返回列表中的工时。',parameters:{headerId:{type:'string',description:'工时编号；没有指定则传空字符串'}},output,execute:async(args,e)=>{if(!e.agent)throw fail('需要会话');e.signal.throwIfAborted();this.reviews.claimed(String(e.agent.id));const result=await this.read(String(e.agent.id),args.headerId);e.signal.throwIfAborted();return JSON.stringify(result)}}))
    this.ctx.tools.register(defineTool({name:'oryh_timesheet_propose',description:'帮用户填写中间栏上正在编辑、尚未保存的工时表单；只改这张表单，不写服务端。新建、修改、提交或审批工时请按工时 skill 在对话里直接完成，不用这个工具。先 read 获取 revision，传 action 对象。新建表单：kind=create；编辑已打开的工时：kind=update,headerId，fields 中已有行保留 id，新增行不传 id，删除行从 entries 移除。优先更新整张表单，由用户在页面统一保存。fields 为完整快照，保留未要求修改的内容。允许分步填写：未知字段保留空字符串，未填写小时保留 0，不必等所有内容齐全；页面保存时会校验完整性。添加明细：kind=add-line,headerId,line。编辑：kind=edit-line,headerId,entryId,line。删除明细：kind=delete-line,headerId,entryId。只传该操作需要的字段。关联项目必须同时给出 project_id 与 project_name，名称逐字取自 read 的 projects；两者不一致会被拒绝，这是为了拦住编号解析错误。不关联项目时 project_id 与 project_name 都传空字符串。read 的 ambiguousProjects 列出同名项目，遇到时必须先反问用户是哪一个，不要自行挑选。日期为 YYYY-MM-DD，工时类型必须使用 read 返回的 name。create 和 update 自动更新中间栏的未保存表单，无需点击应用。成功回执里的 applied 是页面实际生效的内容（项目编号与名称、每日工时、合计），向用户复述必须依据它，不能复述本次调用的参数；表单尚未保存到服务端。',parameters:{revision:{type:'integer',required:true},action:actionSpec},output,execute:async(args,e)=>{if(!e.agent)throw fail('需要会话');e.signal.throwIfAborted();const id=String(e.agent.id);const result=await this.propose(id,args.revision,args.action);if(args.action.kind==='create'||args.action.kind==='update'){try{
      const applied=await this.queue.wait<{message:string;applied:ReturnType<typeof appliedSummary>|undefined}>(id,'timesheet-form',{
        invalid:()=>this.states.get(id)?undefined:'页面已离开，填写已取消',
        until:()=>{const state=this.states.get(id);if(!state||state.revision===args.revision)return undefined
          // A synced page need not carry a form at all, so there may be nothing to summarize.
          const form=state.fields
          const matched=form!==undefined&&JSON.stringify(pageFields.safeParse(form).data)===JSON.stringify(pageFields.safeParse(args.action.fields).data)
          if(matched)this.seen.set(id,JSON.stringify(form))
          // The summary comes from the page's own snapshot either way, so a mismatch reports what
          // the form actually holds instead of what was requested.
          return {message:matched?'中间栏工时表单已更新，尚未保存到服务端。以下 applied 是页面实际内容，请按它向用户复述，不要复述本次参数。':'表单发生其他修改，请重新读取，不能声称填写成功。以下 applied 是页面实际内容。',
            applied:form===undefined?undefined:appliedSummary(form,result.projects)}},
        expired:'表单未确认填写，请重新读取。',timeoutMs:6000,signal:e.signal,
      })
      return JSON.stringify(applied)
    }catch(error){if(this.proposals.get(id)?.id===result.proposalId)this.proposals.delete(id);throw error}}return JSON.stringify(result)}}))
    this.ctx.effect(()=>()=>{this.states.clear();this.proposals.clear();this.seen.clear()},'oryh timesheet suggestions')
  }
}
