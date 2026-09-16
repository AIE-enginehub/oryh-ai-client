import { desktopSkillService } from '@oryh/ai-client-core'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe,it,expect,vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { OryhClientController } from '@oryh/ai-client-core'
import type { TodoDetailService } from '@oryh/ai-client-todos'
import { BusinessChat } from '../src/business-chat.js'
const connectionId='c' as import('@oryh/ai-client-foundation').ConnectionId
async function setup(api?:import('@oryh/ai-client-timesheets').OryhTimesheetRemote){
 const directory=await mkdtemp(join(tmpdir(),'oryh-chat-'))
 const agent={id:'s',status:'idle',session:{header:{isSeeded:false,parentSession:undefined as string|undefined}}}
 const identity={id:connectionId,origin:'https://oryh.example',identity:{permissions:['master_data.manage','expense.submit_own','timesheet.submit_own','approval.record','order.submit_own','inventory.manage'],tenant:{id:'tenant'},user:{id:'user',employeeId:'employee'}}}
 let read=async()=>({todoId:'todo',title:'业务待办',entityType:'sales_quotation',entityId:'q',fetchedAt:'now',sections:[]})
 const ctx={agents:{get:(id:string)=>id==='s'?agent:undefined}} as unknown as Context
 const controller={verifyConnection:async()=>identity,listConnections:async()=>[identity]} as unknown as OryhClientController
 const details={read:()=>read()} as unknown as TodoDetailService
 const create=()=>new BusinessChat(ctx,controller,details,directory,api)
 return {ctx,chat:create(),create,identity,agent,setRead:(fn:typeof read)=>{read=fn},close:()=>rm(directory,{recursive:true,force:true})}
}
describe('session business binding',()=>{
 it('persists enterprise and employee binding across plugin restart, and requires an explicit target',async()=>{
  const f=await setup();try{await expect(f.chat.read('s')).rejects.toThrow(/尚未同步/);expect((await f.chat.select({sessionId:'s',connectionId,todoId:'todo'})).ready).toBe(true);expect((await f.chat.read('s')).entityId).toBe('q');f.identity.identity.tenant.id='other';await expect(f.create().select({sessionId:'s',connectionId,todoId:'todo'})).rejects.toThrow(/其他企业/)}finally{await f.close()}
 })
 it('rejects forked sessions and busy selection, invalidating the previous target',async()=>{
  const f=await setup();try{await f.chat.select({sessionId:'s',connectionId,todoId:'todo'});f.agent.status='running';await expect(f.chat.select({sessionId:'s',connectionId,todoId:'other'})).rejects.toThrow(/正在回答/);await expect(f.chat.read('s')).rejects.toThrow(/尚未同步/);f.agent.status='idle';f.agent.session.header.parentSession='parent';await expect(f.chat.select({sessionId:'s',connectionId,todoId:'todo'})).rejects.toThrow(/分支/)}finally{await f.close()}
 })
 it('discards an in-flight result when the selected page is cleared',async()=>{
  const f=await setup();try{await f.chat.select({sessionId:'s',connectionId,todoId:'todo'});let release!:()=>void;f.setRead(async()=>{await new Promise<void>(r=>{release=r});return {todoId:'todo',title:'old',entityType:'sales_quotation',entityId:'q',fetchedAt:'now',sections:[]}});const result=f.chat.read('s');await new Promise(r=>setTimeout(r,0));f.chat.clear('s');release();await expect(result).rejects.toThrow(/页面已改变/)}finally{await f.close()}
 })
})

describe('chat-first navigation',()=>{
 it('binds the home without erasing the current todo',async()=>{const f=await setup();try{await f.chat.select({sessionId:'s',connectionId,todoId:'todo'});await f.chat.select({sessionId:'s',connectionId,homeOnly:true});expect((await f.chat.read('s')).todoId).toBe('todo')}finally{await f.close()}})
 it('allows only the issued navigation during an active model turn and awaits the actual form',async()=>{const f=await setup();try{
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true});f.agent.status='running'
  const pending=f.chat.openTimesheet('s',new AbortController().signal)
  await new Promise(r=>setTimeout(r,0));const n=f.chat.snapshot('s').navigation;expect(n).toBeDefined()
  await expect(f.chat.select({sessionId:'s',connectionId,timesheetPage:'page',navigationId:'fake'})).rejects.toThrow(/正在回答/)
  await f.chat.select({sessionId:'s',connectionId,timesheetPage:'page',navigationId:n!.id})
  await f.chat.timesheet.sync({sessionId:'s',connectionId,pageKey:'page',navigationId:n!.id,revision:1,manager:false,fields:{period_start:'',period_end:'',source_report_text:'',entries:[]}})
  expect(await pending).toContain('表单已打开');expect(f.chat.snapshot('s').navigation).toBeUndefined()
 }finally{await f.close()}})
 it('refuses navigation when enterprise identity changes',async()=>{const f=await setup();try{await f.chat.select({sessionId:'s',connectionId,homeOnly:true});f.identity.identity.user.employeeId='other';await expect(f.chat.openTimesheet('s',new AbortController().signal)).rejects.toThrow(/身份/)}finally{await f.close()}})
 it('cancels pending navigation on abort',async()=>{const f=await setup();try{await f.chat.select({sessionId:'s',connectionId,homeOnly:true});const c=new AbortController();c.abort();await expect(f.chat.openTimesheet('s',c.signal)).rejects.toThrow();expect(f.chat.snapshot('s').navigation).toBeUndefined()}finally{await f.close()}})
})


describe('open existing timesheet navigation',()=>{
 it.each([false,true])('validates the target before navigation and awaits the matching detail (manager=%s)',async(manager)=>{
  const calls:unknown[]=[]
  const api={timesheetDetail:async(...args:unknown[])=>{calls.push(args);return {header:{id:'header'},canEdit:!manager}}} as unknown as import('@oryh/ai-client-timesheets').OryhTimesheetRemote
  const f=await setup(api)
  try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true});f.agent.status='running'
   const pending=f.chat.openTimesheet('s',new AbortController().signal,'header',manager?'todo':'')
   await new Promise(r=>setTimeout(r,0));await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
  const n=(f.chat.snapshot('s').navigation)!
   expect(calls).toEqual([[connectionId,'header',manager?'todo':undefined]])
   expect(n.headerId).toBe('header');expect(n.manager).toBe(manager)
   await expect(f.chat.select({sessionId:'s',connectionId,timesheetPage:'page',navigationId:n.id,manager:!manager})).rejects.toThrow(/正在回答/)
   await f.chat.select({sessionId:'s',connectionId,timesheetPage:'page',navigationId:n.id,manager})
   await f.chat.timesheet.sync({sessionId:'s',connectionId,pageKey:'page',navigationId:n.id,revision:1,manager,headerId:'header',...(manager?{todoId:'todo'}:{})})
   expect(await pending).toContain('指定工时已在中间栏打开')
  }finally{await f.close()}
 })
 it('replaces an unsaved form only when the agent saw it as it is, so a draft written in Chat gives way to the saved timesheet',async()=>{
  const api={timesheetOptions:async()=>({workTypes:[],projects:[],requirements:[],editableStates:[],submitStates:[]}),timesheetList:async()=>[],timesheetQueue:async()=>[],
   timesheetDetail:async()=>({header:{id:'header'},canEdit:false,entries:[]})} as unknown as import('@oryh/ai-client-timesheets').OryhTimesheetRemote
  const f=await setup(api)
  const form={period_start:'2026-09-14',period_end:'2026-09-18',source_report_text:'',entries:[{work_date:'2026-09-14',hours:8,work_type:'regular',project_id:'',task:'调试',notes:''}]}
  try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true});await f.chat.select({sessionId:'s',connectionId,timesheetPage:'page'})
   const sync=(revision:number,fields:typeof form,localEdits='{}')=>f.chat.timesheet.sync({sessionId:'s',connectionId,pageKey:'page',revision,manager:false,fields,localEdits})
   await sync(1,form)
   // Never read: the agent cannot know what it would throw away.
   await expect(f.chat.openTimesheet('s',new AbortController().signal,'header','',true)).rejects.toThrow(/被用户改动/)
   await f.chat.timesheet.read('s')
   const opening=f.chat.openTimesheet('s',new AbortController().signal,'header','',true)
   await vi.waitFor(()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
   const n=f.chat.snapshot('s').navigation!
   expect(n.discardForm).toBe(JSON.stringify(form))
   await f.chat.timesheet.sync({sessionId:'s',connectionId,pageKey:'page',navigationId:n.id,revision:2,manager:false,headerId:'header'})
   expect(await opening).toContain('原先的未保存表单已放弃')
   // The person changed the form, or has a line open, after the agent read it: theirs to keep.
   await sync(3,form);await f.chat.timesheet.read('s')
   await sync(4,{...form,source_report_text:'我改的'})
   await expect(f.chat.openTimesheet('s',new AbortController().signal,'header','',true)).rejects.toThrow(/被用户改动/)
   await f.chat.timesheet.read('s');await sync(5,{...form,source_report_text:'我改的'},JSON.stringify({editing:{line:form.entries[0]}}))
   await expect(f.chat.openTimesheet('s',new AbortController().signal,'header','',true)).rejects.toThrow(/正在编辑/)
  }finally{await f.close()}
 })
 it('does not publish navigation for an inaccessible record',async()=>{
  const api={timesheetDetail:async()=>{throw Error('没有权限')}} as unknown as import('@oryh/ai-client-timesheets').OryhTimesheetRemote
  const f=await setup(api);try{await f.chat.select({sessionId:'s',connectionId,homeOnly:true});await expect(f.chat.openTimesheet('s',new AbortController().signal,'other')).rejects.toThrow('没有权限');expect(f.chat.snapshot('s').navigation).toBeUndefined()}finally{await f.close()}
 })
})

describe('visible todo navigation',()=>{
 const visibleTodos=[{id:'second-on-server',title:'当前第一条'},{id:'first-on-server',title:'当前第二条'}]
 it('uses visible order and waits for the exact authorized detail to open',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   await f.chat.select({sessionId:'s',connectionId,visibleTodos,listRevision:'v1'})
   expect((await f.chat.visibleTodos('s')).items[0]).toEqual({...visibleTodos[0],position:1})
   f.agent.status='running'
   const pending=f.chat.openTodo('s',1,'v1',new AbortController().signal)
   await new Promise(r=>setTimeout(r,0))
   await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
  const n=(f.chat.snapshot('s').navigation)!
   expect(n.todoId).toBe('second-on-server');expect(n.target).toBe('todo')
   await expect(f.chat.select({sessionId:'s',connectionId,todoId:'first-on-server',navigationId:n.id})).rejects.toThrow(/正在回答/)
   const selected=await f.chat.select({sessionId:'s',connectionId,todoId:n.todoId!,navigationId:n.id})
   expect(selected.document).toBeDefined()
   expect(await pending).toEqual(selected.document)
  }finally{await f.close()}
 })
 it('rejects old versions, invalid positions and lists no longer visible',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,visibleTodos,listRevision:'v2'})
   await expect(f.chat.openTodo('s',1,'v1',new AbortController().signal)).rejects.toThrow(/列表已改变/)
   for(const index of [0,3,1.5])await expect(f.chat.openTodo('s',index,'v2',new AbortController().signal)).rejects.toThrow(/序号/)
   f.chat.clear('s');await expect(f.chat.visibleTodos('s')).rejects.toThrow(/没有已同步/)
  }finally{await f.close()}
 })
 it('rejects inaccessible targets before issuing a navigation command',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   await f.chat.select({sessionId:'s',connectionId,visibleTodos,listRevision:'v1'})
   f.setRead(async()=>{throw Error('不属于当前员工')})
   await expect(f.chat.openTodo('s',1,'v1',new AbortController().signal)).rejects.toThrow(/不属于/)
   expect(f.chat.snapshot('s').navigation).toBeUndefined()
  }finally{await f.close()}
 })
})

it('refreshes list context during a model turn and invalidates its old ordinal',async()=>{
 const f=await setup();try{
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  await f.chat.select({sessionId:'s',connectionId,visibleTodos:[{id:'old',title:'old'}],listRevision:'before'})
  f.agent.status='running'
  await f.chat.select({sessionId:'s',connectionId,visibleTodos:[{id:'new',title:'new'}],listRevision:'after'})
  await expect(f.chat.openTodo('s',1,'before',new AbortController().signal)).rejects.toThrow(/列表已改变/)
  expect((await f.chat.visibleTodos('s')).items[0]!.id).toBe('new')
 }finally{await f.close()}
})

describe('root page context',()=>{
 it('switches from timesheet to projects during a model turn and rejects late old bindings',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'view',revision:1,page:'timesheets'})
   await f.chat.select({sessionId:'s',connectionId,timesheetPage:'form'})
   await f.chat.timesheet.sync({sessionId:'s',connectionId,pageKey:'form',revision:1,manager:false,fields:{period_start:'',period_end:'',source_report_text:'',entries:[]}})
   f.agent.status='running'
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'view',revision:2,page:'list-projects',context:{key:'list-projects:list',title:'项目',detail:'筛选：技改',scope:'7 条'}})
   expect(f.chat.currentPage('s')).toMatchObject({page:'list-projects',capabilities:{create:true}})
   expect(f.chat.timesheet.current('s')).toBeUndefined()
   await expect(f.chat.timesheet.read('s')).rejects.toThrow()
   await expect(f.chat.select({sessionId:'s',connectionId,timesheetPage:'form'})).rejects.toThrow(/旧页面/)
   f.chat.clear('s');expect(f.chat.currentPage('s').page).toBe('list-projects')
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'view',revision:1,page:'timesheets'})
   expect(f.chat.currentPage('s').page).toBe('list-projects')
  }finally{await f.close()}
 })
 it('does not revive an old todo detail after the user leaves its page',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'view',revision:1,page:'my-open-todos'})
   let release!:()=>void,started!:()=>void
   const reading=new Promise<void>(r=>{started=r})
   f.setRead(async()=>{started();await new Promise<void>(r=>{release=r});return {todoId:'todo',title:'old',entityType:'sales_quotation',entityId:'q',fetchedAt:'now',sections:[]}})
   const pending=f.chat.select({sessionId:'s',connectionId,todoId:'todo'})
   await reading
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'view',revision:2,page:'list-projects'})
   release();await expect(pending).rejects.toThrow(/旧页面/)
   expect(f.chat.currentPage('s').title).toBe('项目')
  }finally{await f.close()}
 })
})

describe('live page background and navigation',()=>{
 it('includes the latest list snapshot and requires the navigation acknowledgement',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'list-projects',context:{key:'list',title:'项目',detail:'筛选',scope:'当前页',content:'项目甲'}})
   expect(f.chat.currentPage('s').context?.content).toBe('项目甲')
   const pending=f.chat.navigate('s','my-expense-claims',new AbortController().signal)
   await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
    const command=(f.chat.snapshot('s').navigation)!
   expect(command.target).toBe('page')
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'my-expense-claims',navigationId:command.id,context:{key:'expenses',title:'费用',detail:'',scope:'',content:'费用乙'}})
   expect(JSON.parse(await pending).context.content).toBe('费用乙')
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'list-projects'})
   expect(f.chat.currentPage('s').page).toBe('my-expense-claims')
  }finally{await f.close()}
 })
 it('publishes current project fields without confirmation credentials and clears them on leaving',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'list-projects'})
   const fields={project_name:'人工输入',project_code:'',client:'',start_date:'',end_date:''}
   f.chat.project.sync({sessionId:'s',connectionId,pageKey:'p',revision:1,fields,busy:false})
   expect(f.chat.currentPage('s').visible).toMatchObject({fields,unsaved:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'settings'})
   expect(f.chat.currentPage('s').visible).toBeUndefined()
  }finally{await f.close()}
 })
})

it('accepts manual page selection during a turn only when the root page matches',async()=>{
 const f=await setup();try{
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'my-open-todos'})
  f.agent.status='running'
  expect((await f.chat.select({sessionId:'s',connectionId,todoId:'todo'})).ready).toBe(true)
  expect(f.chat.currentPage('s').visible).toMatchObject({document:{todoId:'todo'}})
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'list-projects'})
  await expect(f.chat.select({sessionId:'s',connectionId,todoId:'todo'})).rejects.toThrow(/旧页面/)
 }finally{await f.close()}
})

it('changes project columns only after matching page acknowledgement',async()=>{
 const f=await setup();try{
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  const context={key:'list-projects:list',title:'项目',detail:'',scope:'',columns:['name','status'] as import('../src/types.js').ProjectColumn[]}
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'list-projects',context})
  await expect(f.chat.configureProjectColumns('s',['name','password'],new AbortController().signal)).rejects.toThrow(/列配置/)
  const pending=f.chat.configureProjectColumns('s',['name','createdAt'],new AbortController().signal)
  await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
  const n=(f.chat.snapshot('s').navigation)!
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'list-projects',navigationId:n.id,context:{...context,columns:['name','createdAt']}})
  expect(await pending).toContain('显示列已更新')
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:3,page:'timesheets'})
  await expect(f.chat.configureProjectColumns('s',['name'],new AbortController().signal)).rejects.toThrow(/项目列表/)
 }finally{await f.close()}
})

for(const kind of ['sales-orders','inventory-items','inventory-item-details','shipments'] as const){
 it(`updates ${kind} columns through acknowledged plugin navigation`,async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   const context={key:`${kind}:list`,title:kind,detail:'',scope:'',columns:['id']}
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:kind,context})
   for(const columns of [[],['password'],['__proto__'],['id','id']])await expect(f.chat.configureRecordColumns('s',columns,new AbortController().signal)).rejects.toThrow(/列配置/)
   const pending=f.chat.configureRecordColumns('s',['id'],new AbortController().signal)
   await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
  const n=(f.chat.snapshot('s').navigation)!
   expect(n).toMatchObject({target:'columns',page:kind,columns:['id']})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:kind,navigationId:n.id,context})
   expect(await pending).toContain('显示列已更新')
   const cancelled=f.chat.configureRecordColumns('s',['id'],new AbortController().signal)
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:3,page:'timesheets'})
   await expect(cancelled).rejects.toThrow(/页面已变化/)
   await expect(f.chat.configureRecordColumns('s',['id'],new AbortController().signal)).rejects.toThrow(/列表/)
  }finally{await f.close()}
 })
}
/** What `GET /inventory-item-details` declares on a real deployment: no effective-date parameter. */
const detailFields=[{name:'inventory_item_id',type:'string'},{name:'reason',type:'string'},{name:'entity_type',type:'string'},{name:'include_archived_items',type:'boolean'}]

it('offers query fields the list endpoint declares, and the product query on inventory movements',async()=>{
 const f=await setup();try{
  f.ctx.oryhRecords={recordFilterFields:async()=>detailFields,recordList:async()=>({rows:[],page:1,pages:1,total:4,fetchedAt:'now'})} as never
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  const context={key:'inventory-item-details:list',title:'库存流水',detail:'',scope:'',queryFields:[] as string[]}
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'inventory-item-details',context})
  const pending=f.chat.configureQueryFields('s',['product_code','reason'],[{field:'reason',value:'sale'}],undefined,new AbortController().signal)
  await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
  const n=(f.chat.snapshot('s').navigation)!
  expect(n).toMatchObject({target:'filters',page:'inventory-item-details',queryFields:['product_code','reason'],queryValues:{reason:'sale'}})
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'inventory-item-details',navigationId:n.id,context:{...context,queryFields:['product_code','reason'],queryValues:{reason:'sale'}}})
  const receipt=await pending
  expect(receipt).toContain('查询栏已更新')
  expect(receipt).toContain('共 4 条')
 }finally{await f.close()}
})

it('says plainly that ORYH does not support a field the endpoint does not declare',async()=>{
 const f=await setup();try{
  f.ctx.oryhRecords={recordFilterFields:async()=>detailFields} as never
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  const context={key:'inventory-item-details:list',title:'库存流水',detail:'',scope:'',queryFields:[] as string[]}
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'inventory-item-details',context})
  // The reported case: 生效日期 is not a query parameter of this endpoint. The refusal must name the gap
  // as the server's and steer away from an invented on-page workaround.
  const refusal=f.chat.configureQueryFields('s',['effective_at'],undefined,undefined,new AbortController().signal)
  await expect(refusal).rejects.toThrow(/ORYH 目前不支持按“effective_at”查询库存流水/)
  await expect(f.chat.configureQueryFields('s',['effective_at'],undefined,undefined,new AbortController().signal)).rejects.toThrow(/不要建议在页面上自行筛选/)
  // The search box already owns its field, so it is not offered twice.
  await expect(f.chat.configureQueryFields('s',['inventory_item_id'],undefined,undefined,new AbortController().signal)).rejects.toThrow(/不支持/)
  // A value must belong to a field that is shown.
  await expect(f.chat.configureQueryFields('s',['reason'],[{field:'entity_type',value:'x'}],undefined,new AbortController().signal)).rejects.toThrow(/已显示的查询字段/)
  expect(f.chat.snapshot('s').navigation).toBeUndefined()
 }finally{await f.close()}
})

it('hydrates multi-product selections before sending them to the page',async()=>{
 const f=await setup();try{
  const products=[{id:'a',name:'Product A',code:'A'},{id:'b',name:'Product B',code:'B'}]
  f.ctx.oryhRecords={recordFilterFields:async()=>detailFields,productSearch:async()=>({rows:products,total:2,pages:1})} as never
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  const context={key:'inventory-item-details:list',title:'库存流水',detail:'',scope:''}
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'inventory-item-details',context})
  await expect(f.chat.configureQueryFields('s',['product_code'],undefined,undefined,new AbortController().signal,['a','a'])).rejects.toThrow(/选择无效/)
  const pending=f.chat.configureQueryFields('s',['product_code'],undefined,undefined,new AbortController().signal,['a','b'])
  await new Promise(r=>setTimeout(r,0))
  await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
  const n=(f.chat.snapshot('s').navigation)!
  expect(n.products).toEqual(products)
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'inventory-item-details',navigationId:n.id,context:{...context,queryFields:['product_code'],productIds:['a','b']}})
  expect(await pending).toContain('查询栏已更新')
 }finally{await f.close()}
})

it('configures the query bar of any list, not only inventory movements',async()=>{
 const f=await setup();try{
  f.ctx.oryhRecords={recordFilterFields:async()=>[{name:'direction',type:'string'},{name:'keyword',type:'string'}],recordList:async()=>({rows:[],page:1,pages:1,total:0,fetchedAt:'now'})} as never
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  const context={key:'shipments:list',title:'收发货',detail:'',scope:'',queryFields:[] as string[]}
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'shipments',context})
  // Product queries exist only for inventory movements.
  await expect(f.chat.configureQueryFields('s',['product_code'],undefined,undefined,new AbortController().signal)).rejects.toThrow(/不支持/)
  const pending=f.chat.configureQueryFields('s',['direction'],undefined,undefined,new AbortController().signal)
  await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
  const n=(f.chat.snapshot('s').navigation)!
  expect(n).toMatchObject({target:'filters',page:'shipments',queryFields:['direction']})
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'shipments',navigationId:n.id,context:{...context,queryFields:['direction']}})
  expect(await pending).toContain('查询栏已更新')
 }finally{await f.close()}
})

it('does not queue Chat navigation after the server revokes the required grant',async()=>{
 const f=await setup();try{
  await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
  f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'my-open-todos'})
  f.identity.identity.permissions=[]
  await expect(f.chat.navigate('s','inventory-items',new AbortController().signal)).rejects.toThrow('权限')
  expect(f.chat.snapshot('s').navigation).toBeUndefined()
 }finally{await f.close()}
})

describe('command stream',()=>{
 it('opens with a baseline, republishes the whole set on change, and re-baselines a reconnect',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   const controller=new AbortController()
   const frames=f.chat.commands({sessionId:'s',connectionId},controller.signal)[Symbol.asyncIterator]()
   expect(await frames.next()).toEqual({value:{type:'baseline',commands:{}},done:false})
   const pending=frames.next()
   const navigating=f.chat.openTimesheet('s',new AbortController().signal)
   const update=(await pending).value
   expect(update.type).toBe('update')
   const command=update.commands.navigation!
   expect(command).toBeDefined()
   // A reconnect re-opens the stream: its baseline still carries the command the page never saw.
   const reopened=f.chat.commands({sessionId:'s',connectionId},new AbortController().signal)[Symbol.asyncIterator]()
   expect((await reopened.next()).value).toEqual({type:'baseline',commands:{navigation:command}})
   controller.abort()
   await f.chat.select({sessionId:'s',connectionId,timesheetPage:'page',navigationId:command.id})
   await f.chat.timesheet.sync({sessionId:'s',connectionId,pageKey:'page',navigationId:command.id,revision:1,manager:false,fields:{period_start:'',period_end:'',source_report_text:'',entries:[]}})
   expect(await navigating).toContain('表单已打开')
   expect(f.chat.snapshot('s').navigation).toBeUndefined()
  }finally{await f.close()}
 })
 // Drives the Host until a command is actually pending, so the change provably lands
 // while no consumer is awaiting the queue — the window a `wake`-only handoff loses.
 const settled=async(chat:BusinessChat,until:()=>boolean)=>{
  for(let tick=0;tick<1000&&!until();tick++)await new Promise(resolve=>{setImmediate(resolve)})
  if(!until())throw new Error('the Host never reached the expected snapshot')
 }
 it('delivers a command issued between frames, without waiting for a further change',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   const controller=new AbortController()
   const frames=f.chat.commands({sessionId:'s',connectionId},controller.signal)[Symbol.asyncIterator]()
   expect((await frames.next()).value).toEqual({type:'baseline',commands:{}})
   // Nothing is awaiting the stream here: next() is called only once the Host already holds it.
   const tool=new AbortController()
   const navigating=f.chat.openTimesheet('s',tool.signal).catch(()=>undefined)
   await settled(f.chat,()=>f.chat.snapshot('s').navigation!==undefined)
   const update=(await frames.next()).value
   expect(update.type).toBe('update')
   expect(update.commands.navigation).toBeDefined()
   controller.abort();tool.abort();await navigating
  }finally{await f.close()}
 })
 it('coalesces changes across a slow consumer into the current whole set',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   const controller=new AbortController()
   const frames=f.chat.commands({sessionId:'s',connectionId},controller.signal)[Symbol.asyncIterator]()
   await frames.next()
   const firstTool=new AbortController(),secondTool=new AbortController()
   const first=f.chat.openTimesheet('s',firstTool.signal).catch(()=>undefined)
   await settled(f.chat,()=>f.chat.snapshot('s').navigation!==undefined)
   const superseded=f.chat.snapshot('s').navigation!.id
   // A second command on the same lane replaces the first while the consumer is still idle.
   const second=f.chat.openTimesheet('s',secondTool.signal).catch(()=>undefined)
   await settled(f.chat,()=>f.chat.snapshot('s').navigation!.id!==superseded)
   const update=(await frames.next()).value
   expect(update.commands).toEqual(f.chat.snapshot('s'))
   expect(update.commands.navigation!.id).not.toBe(superseded)
   controller.abort();firstTool.abort();secondTool.abort();await Promise.all([first,second])
  }finally{await f.close()}
 })
 it('ends the subscription when cancelled while waiting and while a frame is in flight',async()=>{
  const f=await setup();try{
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   const waiting=new AbortController()
   const idle=f.chat.commands({sessionId:'s',connectionId},waiting.signal)[Symbol.asyncIterator]()
   await idle.next()
   const pending=idle.next()
   waiting.abort()
   expect((await pending).done).toBe(true)
   // Cancelled in the same window the notification fix covers: a frame is out, none requested.
   const processing=new AbortController()
   const busy=f.chat.commands({sessionId:'s',connectionId},processing.signal)[Symbol.asyncIterator]()
   await busy.next()
   processing.abort()
   expect((await busy.next()).done).toBe(true)
  }finally{await f.close()}
 })
 it('refuses a session that is not bound to the enterprise',async()=>{
  const f=await setup();try{
   const stream=f.chat.commands({sessionId:'s',connectionId},new AbortController().signal)
   await expect((async()=>{for await(const frame of stream)return frame})()).rejects.toThrow(/尚未绑定/)
  }finally{await f.close()}
 })
})
describe('menu entries a person adds through chat',()=>{
 const inbound={field:'direction',value:'inbound'}
 /**
  * In-memory stand-ins for the Harness storage domain and workspace registry. Two workspaces, so the
  * tests can show an entry belongs to the workspace its session runs in.
  */
 function harness(f:Awaited<ReturnType<typeof setup>>,cwd='/ws/a'){
  const rows=new Map<string,unknown>()
  const table={get:(k:string)=>rows.get(k),put:async(k:string,v:unknown)=>{rows.set(k,v)},delete:async(k:string)=>rows.delete(k),entries:()=>rows.entries(),keys:()=>rows.keys(),get size(){return rows.size}}
  const storage={open:vi.fn(async()=>({name:'oryh_user_views',table:()=>table,close:async()=>{}}))}
  const workspaces={resolveByPath:async(path:string)=>path==='/ws/a'?{id:'wsA'}:path==='/ws/b'?{id:'wsB'}:undefined}
  Object.assign(f.agent.session.header,{cwd})
  Object.assign(f.ctx,{get:(name:string)=>name==='storageDomain'?storage:name==='workspaceRegistry'?workspaces:undefined,effect:()=>{}})
  return {rows,storage}
 }
 it('reads the list with the filters first, then saves the entry in the session workspace',async()=>{
  const f=await setup();try{
   const {rows}=harness(f)
   const recordList=vi.fn(async()=>({rows:[],page:1,pages:1,total:7,fetchedAt:'now'}))
   Object.assign(f.ctx,{oryhRecords:{recordList}})
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'my-open-todos'})
   const receipt=JSON.parse(await f.chat.addUserView('s','入库单','shipments',[inbound]))
   // The read is the validation: the records service refuses an undeclared key before anything is saved.
   expect(recordList).toHaveBeenCalledWith(expect.objectContaining({kind:'shipments',filters:{direction:'inbound'}}))
   expect(receipt).toMatchObject({added:{label:'入库单',kind:'shipments',filters:{direction:'inbound'}},rows:7})
   // Durable on return, with no page acknowledgement: the entry is in the workspace's table.
   const [key,stored]=[...rows.entries()][0]!
   expect(key.startsWith('wsA ')).toBe(true)
   expect((stored as {views:unknown[]}).views).toHaveLength(1)
   // Published to the page, and visible to the model by the person's own name.
   expect(f.chat.snapshot('s').userViews).toEqual([receipt.added])
   expect(f.chat.currentPage('s').userMenu).toEqual([receipt.added])
   await expect(f.chat.addUserView('s','入库单','shipments',[inbound])).rejects.toThrow(/已经有/)
  }finally{await f.close()}
 })

 it('changes nothing when the list refuses the filters',async()=>{
  const f=await setup();try{
   const {rows}=harness(f)
   const recordList=vi.fn(async()=>{throw new Error('列表不支持按“directon”筛选。可用字段：direction')})
   Object.assign(f.ctx,{oryhRecords:{recordList}})
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'my-open-todos'})
   await expect(f.chat.addUserView('s','入库单','shipments',[{field:'directon',value:'inbound'}])).rejects.toThrow(/directon/)
   expect(rows.size).toBe(0)
   await expect(f.chat.addUserView('s','入库单','purchase-requests',[inbound])).rejects.toThrow(/已有列表/)
   await expect(f.chat.addUserView('s','','shipments',[inbound])).rejects.toThrow(/1–24/)
  }finally{await f.close()}
 })

 it('keeps a separate menu per workspace',async()=>{
  const a=await setup(),b=await setup();try{
   const stored=harness(a,'/ws/a')
   Object.assign(a.ctx,{oryhRecords:{recordList:async()=>({rows:[],page:1,pages:1,total:0,fetchedAt:'now'})}})
   await a.chat.select({sessionId:'s',connectionId,homeOnly:true})
   await a.chat.addUserView('s','入库单','shipments',[inbound])
   // Another session in a different workspace, over the same storage, sees none of it.
   harness(b,'/ws/b')
   Object.assign(b.ctx,{get:(name:string)=>name==='storageDomain'?stored.storage:name==='workspaceRegistry'?{resolveByPath:async()=>({id:'wsB'})}:undefined})
   await b.chat.select({sessionId:'s',connectionId,homeOnly:true})
   expect(await b.chat.refreshMenu('s')).toEqual([])
  }finally{await a.close();await b.close()}
 })

 it('opens an entry only once the page shows it, and removes one from the workspace',async()=>{
  const f=await setup();try{
   harness(f)
   Object.assign(f.ctx,{oryhRecords:{recordList:async()=>({rows:[],page:1,pages:1,total:0,fetchedAt:'now'})}})
   await f.chat.select({sessionId:'s',connectionId,homeOnly:true})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:1,page:'my-open-todos'})
   const view=JSON.parse(await f.chat.addUserView('s','入库单','shipments',[inbound])).added
   await expect(f.chat.openUserView('s','missing',new AbortController().signal)).rejects.toThrow(/没有这个菜单项/)

   const opening=f.chat.openUserView('s',view.id,new AbortController().signal)
   await vi.waitFor(async()=>expect(f.chat.snapshot('s').navigation).toBeDefined())
   const open=f.chat.snapshot('s').navigation!
   // The command names the list the entry narrows, so a page sync on that list keeps it alive.
   expect(open).toMatchObject({target:'view',userViewId:view.id,page:'shipments'})
   f.chat.pageSync({sessionId:'s',connectionId,viewId:'v',revision:2,page:'shipments',navigationId:open.id,context:{key:'shipments:list',title:'入库单',detail:'',scope:'',view}})
   expect(JSON.parse(await opening)).toMatchObject({page:'shipments',title:'入库单'})

   expect(await f.chat.removeUserView('s',view.id)).toContain('已删除菜单项“入库单”')
   expect(f.chat.snapshot('s').userViews).toEqual([])
   await expect(f.chat.removeUserView('s',view.id)).rejects.toThrow(/没有这个菜单项/)
  }finally{await f.close()}
 })
})

describe('the agent as the primary client',()=>{
 const principal={origin:'https://oryh.example',tenantId:'tenant',userId:'user',employeeId:'employee',tenantName:'晶诚',email:'hua@example.invalid'}
 /** The chat with its tools and listeners installed, on a context that records both. */
 async function installed(connections=1,holder:typeof principal|null=null,mcpTools:{name:string;readOnly:boolean;isError?:boolean}[]=[],capabilities?:{shell:boolean;writes:boolean}){
  const directory=await mkdtemp(join(tmpdir(),'oryh-chat-'))
  let prompt=''
  const agent={id:'s',status:'idle',session:{header:{isSeeded:false,parentSession:undefined as string|undefined}}}
  const identity={id:connectionId,origin:'https://oryh.example',identity:{permissions:[],tenant:{id:'tenant',name:'晶诚'},user:{id:'user',email:'hua@example.invalid',employeeId:'employee'}}}
  const tools=new Map<string,{execute:(args:unknown,exec:unknown)=>Promise<string>}>()
  const listeners=new Map<string,((...args:never[])=>unknown)[]>()
  const ctx={
   agents:{get:(id:string)=>id==='s'?agent:undefined,list:()=>[]},
   tools:{register:(tool:{name:string})=>{tools.set(tool.name,tool as never);return()=>{tools.delete(tool.name)}}},
   systemPrompt:{section:(s:{text:string})=>{prompt=s.text}},
   // Effects run, so the per-agent tool policy is really applied when an agent is created.
   effect:(fn:()=>unknown)=>{fn()},
   on:(name:string,fn:(...args:never[])=>unknown)=>{listeners.set(name,[...(listeners.get(name)??[]),fn])},
  } as unknown as Context
  const controller={verifyConnection:async()=>identity,listConnections:async()=>[identity,{...identity,id:'c2'}].slice(0,connections)} as unknown as OryhClientController
  const sync=vi.fn(async()=>({installed:true,root:'/skills',skills:[],message:'已安装。'}))
  const skills=desktopSkillService({sync,installedPrincipal:()=>holder})
  const callTool=vi.fn(async(_c:string,name:string)=>{const tool=mcpTools.find(t=>t.name===name)!;return {text:tool.isError?'{"detail":"refused"}':'{"data":[]}',isError:Boolean(tool.isError)}})
  const mcp={tools:async()=>mcpTools.map(t=>({name:t.name,description:t.name,inputSchema:{type:'object',properties:{}},readOnly:t.readOnly})),callTool} as unknown as import('@oryh/ai-client-core').OryhMcpClient
  const chat=new BusinessChat(ctx,controller,{read:async()=>({})} as unknown as TodoDetailService,directory,undefined,undefined,skills,mcp,capabilities)
  chat.install()
  const exec={agent:{id:'s'},callId:'call-1',signal:new AbortController().signal}
  return {chat,sync,exec,callTool,prompt:()=>prompt,
   /** An agent as the runtime creates it, with the tool policy it is given recorded. */
   created:()=>{const policies:{allow:string[];lifted:boolean}[]=[];const agentCtx={tools:{restrict:(filter:{allow:string[]})=>{const policy={allow:filter.allow,lifted:false};policies.push(policy);return()=>{policy.lifted=true}},presentAs:()=>()=>{}},systemPrompt:{context:()=>()=>{}}};for(const fn of listeners.get('agent/created')??[])(fn as unknown as (p:unknown)=>void)({agent:{id:'s',ctx:agentCtx}});return policies},
   tool:(name:string)=>tools.get(name)!,
   /** A tool call finishing, through the same waterfall the tool runtime drives. */
   ran:async(name:string)=>{for(const fn of listeners.get('tools/post-execute')??[])await (fn as unknown as (e:unknown,r:unknown,n:()=>Promise<unknown>)=>Promise<unknown>)({name,agent:{id:'s'}},{},async()=>({kind:'accept'}))},
   status:(status:string)=>{for(const fn of listeners.get('agent/status')??[])(fn as unknown as (p:unknown)=>void)({agent:{id:'s',inbox:{nextTurn:[]}},status})},
   denied:async(name:string)=>{let result:unknown;for(const fn of listeners.get('tools/pre-execute')??[])result=await (fn as unknown as (e:unknown,n:()=>Promise<unknown>)=>Promise<unknown>)({name,agent:{id:'s'}},async()=>({kind:'allow'}));return result as {kind:string;reason?:string}},
   bindHome:()=>chat.select({sessionId:'s',connectionId,homeOnly:true}),
   close:()=>rm(directory,{recursive:true,force:true})}
 }
 it('on a read-only server without a shell, never offers bash and tells the agent it cannot write',async()=>{
  const f=await installed(1,null,[],{shell:false,writes:false});try{
   const [policy]=f.created()
   expect(policy!.allow).not.toContain('bash')
   expect(policy!.allow).toContain('skill')
   expect((await f.denied('bash')).kind).toBe('deny')
   expect(f.prompt()).toMatch(/目前只读/)
   expect(f.prompt()).not.toMatch(/bash 只用于/)
  }finally{await f.close()}
  const desktop=await installed();try{
   expect(desktop.created()[0]!.allow).toContain('bash')
   expect(desktop.prompt()).not.toMatch(/目前只读/)
  }finally{await desktop.close()}
 })
 it('answers that no page is open instead of failing, so the agent carries on through skills',async()=>{
  const f=await installed();try{
   const page=JSON.parse(await f.tool('oryh_current_page').execute({},f.exec))
   expect(page.page).toBeNull()
   expect(page.notice).toMatch(/skill/)
   await expect(f.tool('oryh_navigate').execute({page:'timesheets'},f.exec)).rejects.toThrow(/没有打开的业务页面/)
  }finally{await f.close()}
 })
 it('syncs skills for the only enterprise when no page is bound, and asks when there are several',async()=>{
  const one=await installed(1);try{await one.tool('oryh_skill_sync').execute({},one.exec);expect(one.sync).toHaveBeenCalledWith(connectionId,true)}finally{await one.close()}
  const two=await installed(2);try{await expect(two.tool('oryh_skill_sync').execute({},two.exec)).rejects.toThrow(/多个企业连接/);expect(two.sync).not.toHaveBeenCalled()}finally{await two.close()}
 })
 it('tells the agent whose skills it would write with, and whether that is this session enterprise',async()=>{
  const none=await installed(1,null);try{expect(none.chat.skillIdentity('s')).toMatch(/oryh_skill_sync/)}finally{await none.close()}
  const same=await installed(1,principal);try{
   expect(same.chat.skillIdentity('s')).toContain('属于：晶诚 · hua@example.invalid。')
   await same.bindHome();expect(same.chat.skillIdentity('s')).toMatch(/身份一致/)
  }finally{await same.close()}
  // After switching accounts the bundle can belong to someone else: the agent must not write with it.
  const other=await installed(1,{...principal,userId:'someone-else',email:'other@example.invalid'});try{
   await other.bindHome();expect(other.chat.skillIdentity('s')).toMatch(/不一致.*oryh_skill_sync/)
  }finally{await other.close()}
 })
 it('moves the server-change marker when a turn that ran the shell ends, and only then',async()=>{
  const f=await installed();try{
   await f.ran('oryh_current_page');f.status('idle')
   expect(f.chat.snapshot('s').serverChange).toBeUndefined()
   await f.ran('bash');f.status('running')
   expect(f.chat.snapshot('s').serverChange).toBeUndefined()
   f.status('idle')
   const first=f.chat.snapshot('s').serverChange
   expect(first).toBeDefined()
   // An idle that follows a turn with no shell leaves it alone; the next shell turn moves it again.
   f.status('idle');expect(f.chat.snapshot('s').serverChange).toEqual(first)
   await f.ran('bash');f.status('idle')
   expect(f.chat.snapshot('s').serverChange?.id).not.toBe(first!.id)
  }finally{await f.close()}
 })
 it('never tells the agent that a write has to be confirmed on the page',async()=>{
  const f=await installed();try{
   const decision=await f.denied('some_other_tool')
   expect(decision.kind).toBe('deny')
   expect(decision.reason).not.toMatch(/页面/)
  }finally{await f.close()}
 })
 it('offers ORYH\'s MCP tools as listed by the server, over the session enterprise, without shadowing its own',async()=>{
  const f=await installed(1,null,[{name:'oryh_request',readOnly:false},{name:'oryh_get',readOnly:true},{name:'oryh_current_page',readOnly:true},{name:'bad/name',readOnly:true}])
  try{
   const policies=f.created()
   expect(policies.at(-1)?.allow).not.toContain('oryh_request')
   await f.chat.mcpTools.refresh(connectionId)
   // Listed from the server, not named in code; a Host tool name and a malformed one are not taken.
   expect([...f.chat.mcpTools.names].sort()).toEqual(['oryh_get','oryh_request'])
   // The agent's allow-list grows: the wider policy goes on before the narrower one comes off.
   expect(policies.at(-1)?.allow).toEqual(expect.arrayContaining(['oryh_request','oryh_get','skill']))
   expect(policies.slice(0,-1).every(policy=>policy.lifted)).toBe(true)
   expect((await f.denied('oryh_request')).kind).toBe('allow')
   // A read-only call runs over the session's enterprise and leaves the pane alone.
   expect(await f.tool('oryh_get').execute({},f.exec)).toBe('{"data":[]}')
   expect(f.callTool).toHaveBeenCalledWith(connectionId,'oryh_get',{},{operation:{kind:'chat',operationId:expect.any(String),sessionId:'s',callId:'call-1'}})
   f.status('idle');expect(f.chat.snapshot('s').serverChange).toBeUndefined()
   // A call that may write marks the turn, and the pane re-reads when it ends.
   await f.tool('oryh_request').execute({method:'POST',path:'/timesheet-headers/h/submit'},f.exec)
   f.status('idle');expect(f.chat.snapshot('s').serverChange).toBeDefined()
  }finally{await f.close()}
 })
 it('lets the model see an ORYH refusal as a failure, and does not mark it as a write',async()=>{
  const f=await installed(1,null,[{name:'oryh_request',readOnly:false,isError:true}])
  try{
   await f.chat.mcpTools.refresh(connectionId)
   await expect(f.tool('oryh_request').execute({method:'POST',path:'/x'},f.exec)).rejects.toThrow(/refused/)
   f.status('idle');expect(f.chat.snapshot('s').serverChange).toBeUndefined()
  }finally{await f.close()}
 })
})

