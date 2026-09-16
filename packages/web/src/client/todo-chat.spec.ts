// @vitest-environment jsdom
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {describe,it,expect,vi} from 'vitest'
import {TodoChat,BusinessSessionContext} from './todo-chat.js'
import {CommandsContext,type CommandState} from './command-stream.js'
import {RemoteContext} from './remote.js'
vi.mock('@fluentui/react-components',()=>({Button:({children,onClick}:any)=>h('button',{onClick},children)}))
describe('visible todo context bridge',()=>{
 it('syncs displayed order, opens a matching command, and renders the shared detail receipt',async()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  let selection:any
  const document={todoId:'b',title:'First visible',entityType:'sales_quotation',fetchedAt:new Date().toISOString(),sections:[{name:'quotation',fields:[{name:'quote_number',value:'QT-1'}]}]}
  const api={chatSelect:vi.fn(async r=>{selection=r;return {ready:true,message:'ready',...(r.todoId?{document}:{})}}),chatClear:vi.fn(async()=>{}),todoDetail:vi.fn()}
  // The shared store stands in for the Host command stream: one snapshot, republished on change.
  let state:CommandState={commands:{}}
  const listeners=new Set<()=>void>()
  const store={getSnapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}}
  const publish=(next:CommandState)=>{state=next;for(const listener of [...listeners])listener()}
  const onOpen=vi.fn(),visibleTodos=[{id:'b',title:'First visible'},{id:'a',title:'Second visible'}]
  const node=window.document.createElement('div');window.document.body.append(node);const root=createRoot(node)
  const render=(todoId?:string)=>h(RemoteContext.Provider,{value:api as never},h(CommandsContext.Provider,{value:store},h(BusinessSessionContext.Provider,{value:'s'},h(TodoChat,{connectionId:'c' as never,visibleTodos,listContext:'page 2 descending',onOpen,...(todoId?{todoId,navigationId:'nav'}:{})}))))
  try{
   await act(async()=>root.render(render()))
   expect(selection.visibleTodos).toEqual(visibleTodos)
   expect(onOpen).not.toHaveBeenCalled()
   await act(async()=>{publish({commands:{navigation:{id:'nav',expiresAt:Date.now()+10000,target:'todo',todoId:'b',listRevision:selection.listRevision}}})})
   expect(onOpen).toHaveBeenCalledWith('b','nav')
   await act(async()=>root.render(render('b')))
   expect(node.textContent).toContain('QT-1')
   expect(api.todoDetail).not.toHaveBeenCalled()
  }finally{await act(async()=>root.unmount());node.remove()}
 })
})
