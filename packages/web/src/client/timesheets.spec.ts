// @vitest-environment jsdom
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {describe,it,expect,vi} from 'vitest'
import {TimesheetPanel} from './timesheets.js'
import {RemoteContext} from './remote.js'
import {LocaleContext,dictionaries} from './locale.js'
// Test the business interaction; native Fluent rendering is checked in the browser.
vi.mock('@fluentui/react-components',()=>({
  Button:({appearance,size,icon,children,...props}:any)=>h('button',{type:'button',...props},children),
  Field:({label,children}:any)=>h('label',null,label,children),
  Input:({contentBefore,onChange,...props}:any)=>h('input',{...props,onChange:(e:any)=>onChange?.(e,{value:e.target.value})}),
  Select:({children,...props}:any)=>h('select',props,children),
  Spinner:()=>null,MessageBar:({children}:any)=>h('div',{role:'alert'},children),MessageBarBody:({children}:any)=>h('span',null,children),
  Dialog:({open,children}:any)=>open?h('div',{role:'dialog'},children):null,
  ...Object.fromEntries(['DialogActions','DialogBody','DialogContent','DialogSurface','DialogTitle'].map(name=>[name,({children}:any)=>h('div',null,children)])),
}))
// Keeps the props the panel last gave Chat, which include the unsaved form exactly as it is synced.
vi.mock('./timesheet-chat.js' ,()=>({TimesheetChat:(props:any)=>{(globalThis as any).timesheetChatProps=props;return null}}))

describe('timesheet save feedback',()=>{
  it('shows pending and failure beside save, preserves input, and opens review after retry',async()=>{
    globalThis.IS_REACT_ACT_ENVIRONMENT=true
    let reject!:(e:Error)=>void
    const prepare=vi.fn().mockImplementationOnce(()=>new Promise((_,r)=>{reject=r})).mockResolvedValue({id:'review',action:{kind:'create',fields:{period_start:'2026-09-09',period_end:'2026-09-09',entries:[]}},expiresAt:Date.now()+60000})
    const confirm=vi.fn()
    const api={timesheetList:async()=>[],timesheetOptions:async()=>({workTypes:[],projects:[],requirements:[],submitStates:[],editableStates:[]}),timesheetHistory:async()=>[],timesheetPrepare:prepare,timesheetConfirm:confirm}
    const node=document.createElement('div');document.body.append(node);const root=createRoot(node)
    try{
      await act(async()=>root.render(h(RemoteContext.Provider,{value:api as never},h(LocaleContext.Provider,{value:k=>dictionaries[k]},h(TimesheetPanel,{connection:{id:'c',identity:{permissions:['timesheet.submit_own','approval.record'],tenant:{name:'Test'},user:{email:'test@example.invalid'}}} as never,manager:false,active:false,navigationId:'open',onDirtyChange:()=>{}})))))
      await act(async()=>Array.from(node.querySelectorAll('button')).find(b=>b.textContent==='新建工时单')!.click())
      const form=node.querySelector('form')!, before=Array.from(form.querySelectorAll('input,select,textarea')).map(e=>(e as HTMLInputElement).value)
      await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
      expect(form.querySelector('[role=status]')?.textContent).toBe('正在核对…')
      expect(form.querySelector('fieldset')?.disabled).toBe(true)
      await act(async()=>reject(Error('这个期间已有工时单')))
      expect(form.querySelector('.oryh-ts-save-feedback [role=alert]')?.textContent).toBe('这个期间已有工时单')
      expect(Array.from(form.querySelectorAll('input,select,textarea')).map(e=>(e as HTMLInputElement).value)).toEqual(before)
      expect(form.querySelector('fieldset')?.disabled).toBe(false)
      await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
      expect(document.querySelector('[role=dialog]')?.textContent).toContain('核对本次操作')
      expect(confirm).not.toHaveBeenCalled()
    }finally{await act(async()=>root.unmount());node.remove()}
  })
})

describe('existing timesheet view modes',()=>{
 it.each([true,false])('opens the requested record with server-controlled editability (%s)',async(canEdit)=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const detail={canEdit,header:{id:'h',employee_id:'employee',period_start:'2026-09-01',period_end:'2026-09-01',status:canEdit?'draft':'submitted',source_report_text:''},entries:[{id:'line',work_date:'2026-09-01',hours:8,work_type:'regular',project_id:'',task:'existing work',notes:''}],approval_records:[]}
  const open=vi.fn().mockResolvedValue(detail)
  const api={timesheetList:async()=>[],timesheetOptions:async()=>({workTypes:[{name:'regular',title:'正常工时'}],projects:[],requirements:[],submitStates:['draft'],editableStates:['draft']}),timesheetHistory:async()=>[],timesheetDetail:open}
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node)
  try{
   await act(async()=>root.render(h(RemoteContext.Provider,{value:api as never},h(LocaleContext.Provider,{value:k=>dictionaries[k]},h(TimesheetPanel,{connection:{id:'c',identity:{permissions:['timesheet.submit_own','approval.record'],tenant:{name:'Test'},user:{email:'test@example.invalid'}}} as never,manager:false,active:true,navigationId:'open',navigation:{id:'open',headerId:'h',expiresAt:Date.now()+15000},onDirtyChange:()=>{}})))))
   expect(open).toHaveBeenCalledWith('c','h',undefined)
   expect(node.textContent).toContain(canEdit?'编辑工时':'工时详情 · 只读')
   expect(node.querySelectorAll('form input[type=number]').length).toBe(canEdit?1:0)
   if(canEdit)expect(Array.from(node.querySelectorAll('input')).some(e=>e.value==='existing work')).toBe(true)
   else expect(node.textContent).toContain('existing work')
  }finally{await act(async()=>root.unmount());node.remove()}
 })
})

describe('whole document editing',()=>{
 it('stages add/delete, restores a removed row, and saves once with all remaining rows',async()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const detail={revision:'version',canEdit:true,header:{id:'h',employee_id:'e',period_start:'2026-09-01',period_end:'2026-09-01',status:'draft',source_report_text:''},entries:[{id:'a',work_date:'2026-09-01',hours:8,work_type:'regular',project_id:'',task:'A',notes:''},{id:'b',work_date:'2026-09-01',hours:4,work_type:'regular',project_id:'',task:'B',notes:''}],approval_records:[]}
  const prepare=vi.fn().mockRejectedValue(Error('请检查工时'))
  const api={timesheetList:async()=>[],timesheetOptions:async()=>({workTypes:[{name:'regular',title:'正常工时'}],projects:[],requirements:[],submitStates:['draft'],editableStates:['draft']}),timesheetHistory:async()=>[],timesheetDetail:async()=>detail,timesheetPrepare:prepare}
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node)
  const click=async(text:string)=>act(async()=>Array.from(node.querySelectorAll('button')).find(b=>b.textContent===text)!.click())
  try{
   await act(async()=>root.render(h(RemoteContext.Provider,{value:api as never},h(LocaleContext.Provider,{value:k=>dictionaries[k]},h(TimesheetPanel,{connection:{id:'c',identity:{permissions:['timesheet.submit_own'],tenant:{name:'Test'},user:{email:'test@example.invalid'}}} as never,manager:false,active:true,navigationId:'open',navigation:{id:'open',headerId:'h',expiresAt:Date.now()+15000},onDirtyChange:()=>{}})))))
   await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="删除第 1 条明细"]')!.click())
   expect(node.querySelectorAll('.timesheet-entry')).toHaveLength(1)
   expect(prepare).not.toHaveBeenCalled()
   await click('撤销删除')
   expect(node.querySelectorAll('.timesheet-entry')).toHaveLength(2)
   await click('添加明细')
   expect(node.querySelectorAll('.timesheet-entry')).toHaveLength(3)
   await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="删除第 2 条明细"]')!.click())
   await act(async()=>node.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
   expect(prepare).toHaveBeenCalledTimes(1)
   expect(prepare.mock.calls[0]![1]).toMatchObject({kind:'update',headerId:'h',expectedRevision:'version',fields:{entries:[{id:'a',task:'A'},{hours:0}]}})
   expect(prepare.mock.calls[0]![1].fields.entries[1]).not.toHaveProperty('id')
   expect(node.querySelectorAll('.timesheet-entry')).toHaveLength(2)
   expect(node.querySelector('.oryh-ts-save-feedback [role=alert]')?.textContent).toBe('请检查工时')
   await click('放弃修改')
   expect(Array.from(node.querySelectorAll('input')).map(n=>n.value)).toContain('B')
  }finally{await act(async()=>root.unmount());node.remove()}
 })
})

describe('following writes made in Chat',()=>{
 /** A command stream that is already synced, whose server-change marker the test moves by hand. */
 function stream(){
  let state={commands:{} as {serverChange?:{id:string;at:number}},status:'synced' as const}
  const listeners=new Set<()=>void>()
  return {store:{getSnapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}},
   write:(id:string)=>{state={...state,commands:{serverChange:{id,at:Date.now()}}};listeners.forEach(listener=>listener())}}
 }
 async function openDraft(){
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const {CommandsContext}=await import('./command-stream.js')
  const draft={canEdit:true,revision:'v1',header:{id:'h',employee_id:'e',period_start:'2026-09-07',period_end:'2026-09-11',status:'draft',source_report_text:''},entries:[{id:'a',work_date:'2026-09-07',hours:8,work_type:'regular',project_id:'',task:'装配',notes:''}],approval_records:[]}
  const submitted={...draft,canEdit:false,header:{...draft.header,status:'submitted'}}
  let current:typeof draft=draft
  const api={timesheetList:vi.fn(async()=>[current.header]),timesheetOptions:async()=>({workTypes:[{name:'regular',title:'正常工时'}],projects:[],requirements:[],submitStates:['draft'],editableStates:['draft']}),timesheetHistory:async()=>[],timesheetDetail:vi.fn(async()=>current)}
  const commands=stream()
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node)
  await act(async()=>root.render(h(CommandsContext.Provider,{value:commands.store as never},h(RemoteContext.Provider,{value:api as never},h(LocaleContext.Provider,{value:k=>dictionaries[k]},h(TimesheetPanel,{connection:{id:'c',identity:{permissions:['timesheet.submit_own'],tenant:{name:'Test'},user:{email:'test@example.invalid'}}} as never,manager:false,active:true,navigationId:'open',navigation:{id:'open',headerId:'h',expiresAt:Date.now()+15000},onDirtyChange:()=>{}}))))))
  return {node,api,commands,submit:()=>{current=submitted},close:async()=>{await act(async()=>root.unmount());node.remove()}}
 }
 it('turns the open draft into its submitted detail once Chat submits it, without closing it',async()=>{
  const f=await openDraft()
  try{
   expect(f.node.querySelectorAll('form input[type=number]')).toHaveLength(1)
   f.submit()
   await act(async()=>f.commands.write('turn-1'))
   expect(f.api.timesheetDetail).toHaveBeenCalledTimes(2)
   expect(f.node.querySelector('h1')?.textContent).toBe('2026-09-07 — 2026-09-11')
   expect(f.node.querySelector('.page-title .record-status')?.textContent).toBe('已提交')
   expect(f.node.querySelectorAll('form input[type=number]')).toHaveLength(0)
   expect(f.node.textContent).toContain('工时详情 · 只读')
  }finally{await f.close()}
 })
 it('keeps unsaved edits when Chat writes, and lets the person choose to see the server version',async()=>{
  const f=await openDraft()
  try{
   const task=f.node.querySelector<HTMLInputElement>('input[placeholder="具体完成了什么工作"]')!
   const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
   await act(async()=>{setValue.call(task,'改过的内容');task.dispatchEvent(new Event('input',{bubbles:true}))})
   f.submit()
   await act(async()=>f.commands.write('turn-1'))
   // The list re-read, but the form with its unsaved edit is left exactly as it was.
   expect(f.api.timesheetDetail).toHaveBeenCalledTimes(1)
   expect(f.node.querySelector<HTMLInputElement>('input[placeholder="具体完成了什么工作"]')?.value).toBe('改过的内容')
   expect(f.node.textContent).toContain('服务端数据可能已在 Chat 中更新')
   await act(async()=>Array.from(f.node.querySelectorAll('button')).find(b=>b.textContent==='放弃修改并刷新')!.click())
   expect(f.api.timesheetDetail).toHaveBeenCalledTimes(2)
   expect(f.node.querySelector('.page-title .record-status')?.textContent).toBe('已提交')
   expect(f.node.textContent).not.toContain('服务端数据可能已在 Chat 中更新')
  }finally{await f.close()}
 })
 it('gives up a draft Chat already wrote for the saved timesheet, but only while the form is still what the agent saw',async()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const submitted={canEdit:false,header:{id:'h',employee_id:'e',period_start:'2026-09-14',period_end:'2026-09-18',status:'submitted',source_report_text:''},entries:[],approval_records:[]}
  const api={timesheetList:async()=>[submitted.header],timesheetOptions:async()=>({workTypes:[],projects:[],requirements:[],submitStates:['draft'],editableStates:['draft']}),timesheetHistory:async()=>[],timesheetDetail:vi.fn(async()=>submitted)}
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node)
  const render=(navigation:import('@oryh/dsh-host/types').ChatNavigation)=>act(async()=>root.render(h(RemoteContext.Provider,{value:api as never},h(LocaleContext.Provider,{value:k=>dictionaries[k]},h(TimesheetPanel,{connection:{id:'c',identity:{permissions:['timesheet.submit_own'],tenant:{name:'Test'},user:{email:'test@example.invalid'}}} as never,manager:false,active:true,navigationId:navigation.id,navigation,onDirtyChange:()=>{}})))))
  try{
   await render({id:'new',expiresAt:Date.now()+15000})
   expect(node.textContent).toContain('未保存')
   const form=JSON.stringify((globalThis as any).timesheetChatProps.fields)
   await render({id:'stale',headerId:'h',expiresAt:Date.now()+15000,discardForm:JSON.stringify({...JSON.parse(form),source_report_text:'agent 看到的旧内容'})})
   expect(api.timesheetDetail).not.toHaveBeenCalled()
   expect(node.textContent).toContain('当前有未保存修改')
   await render({id:'open',headerId:'h',expiresAt:Date.now()+15000,discardForm:form})
   expect(api.timesheetDetail).toHaveBeenCalledWith('c','h',undefined)
   expect(node.querySelector('.page-title .record-status')?.textContent).toBe('已提交')
  }finally{await act(async()=>root.unmount());node.remove()}
 })
})
