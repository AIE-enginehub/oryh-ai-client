// @vitest-environment jsdom
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {it,expect,vi} from 'vitest'
import {ChatNavigation} from './chat-navigation.js'
import {RemoteContext} from './remote.js'
import {BusinessSessionContext} from './todo-chat.js'
vi.mock('./todo-chat.js',async()=>({BusinessSessionContext:(await import('react')).createContext<string|undefined>(undefined)}))
it('publishes every menu change and selection context through the root bridge',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const sync=vi.fn(async()=>{}),api={chatSelect:async()=>({}),chatPageSync:sync,chatHomePoll:async()=>undefined,chatHomeClear:async()=>{}}
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node)
 try{
  for(const page of ['timesheets','list-projects','my-expense-claims','settings','my-open-todos','timesheet-approvals'] as const){
   await act(async()=>root.render(h(RemoteContext.Provider,{value:api as never},h(BusinessSessionContext.Provider,{value:'s'},h(ChatNavigation,{connectionId:'c' as never,page,onOpen:()=>{},context:{key:page+':list',title:page,detail:'filtered',scope:'current'}})))))
   expect(sync.mock.lastCall?.[0]).toMatchObject({sessionId:'s',page,context:{key:page+':list'}})
  }
  const revisions=sync.mock.calls.map(c=>c[0].revision)
  expect(revisions).toEqual([...revisions].sort((a,b)=>a-b))
 }finally{await act(async()=>root.unmount());node.remove()}
})
