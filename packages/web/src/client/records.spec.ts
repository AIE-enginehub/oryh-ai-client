// @vitest-environment jsdom
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {it,expect,vi} from 'vitest'
import {RecordPanel} from './records.js'
import {RemoteContext} from './remote.js'
import {formatDisplayValue} from './list-kit.js'
vi.mock('./locale.js',async importOriginal=>{const actual=await importOriginal<typeof import('./locale.js')>();return {...actual,useText:()=>(key:keyof typeof actual.dictionaries)=>actual.dictionaries[key]}})
vi.mock('./product-picker.js',()=>({ProductPicker:()=>h('button',null,'选择产品')}))
vi.mock('@fluentui/react-components',()=>({Spinner:()=>null,MessageBar:({children}:any)=>h('div',{role:'alert'},children),MessageBarBody:({children}:any)=>h('span',null,children),Button:({appearance,size,icon,children,...props}:any)=>h('button',props,children),Field:({label,children}:any)=>h('label',null,label,children),Input:({onChange,...props}:any)=>h('input',{...props,onChange:(e:any)=>onChange?.(e,{value:e.target.value})})}))
it('updates ledger columns and page context without fetching again, and retains record access',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const recordList=vi.fn(async()=>({rows:[{id:'r',title:'issued',fields:[{label:'产品编码',value:'P-1'},{label:'现存数量变动',value:'-1'},{label:'创建时间',value:'2026-09-01T08:00:00Z'}]}],page:1,pages:1,total:1,fetchedAt:''}))
 const api={recordList,recordFilterFields:vi.fn(async()=>[{name:'inventory_item_id',type:'string'},{name:'reason',type:'string'},{name:'include_archived_items',type:'boolean'}])},onContext=vi.fn(),onColumns=vi.fn(),node=document.createElement('div'),root=createRoot(node)
 const render=(columns:string[])=>root.render(h(RemoteContext.Provider,{value:api as never},h(RecordPanel,{kind:'inventory-item-details',connectionId:'c',columns,onColumns,onContext})))
 try{
  await act(async()=>render(['quantity_on_hand_diff']))
  await act(async()=>render(['product_code','created_at','quantity_on_hand_diff']))
  expect(Array.from(node.querySelectorAll('th:not(.row-open-cell)')).map(n=>n.textContent)).toEqual(['产品编码','创建时间','现存数量变动'])
  // Timestamps read as the rest of the workbench writes time, not as the raw ISO string.
  expect(node.querySelector('tbody')?.textContent).toContain(`P-1${formatDisplayValue('2026-09-01T08:00:00Z')}-1`)
  expect(recordList).toHaveBeenCalledTimes(1)
  expect(onContext.mock.lastCall?.[0].columns).toEqual(['product_code','created_at','quantity_on_hand_diff'])
  await act(async()=>node.querySelector<HTMLButtonElement>('.record-link')!.click())
  expect(node.textContent).toContain('记录信息')
  expect(onContext.mock.lastCall?.[0].key).toBe('inventory-item-details:r')
 }finally{await act(async()=>root.unmount())}
})

it('adds a query control without querying and submits the product through the shared Remote',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const recordList=vi.fn(async()=>({rows:[],page:1,pages:1,total:0,fetchedAt:''})),api={recordList,recordFilterFields:vi.fn(async()=>[{name:'inventory_item_id',type:'string'},{name:'reason',type:'string'},{name:'include_archived_items',type:'boolean'}])},onContext=vi.fn()
 const node=document.createElement('div'),root=createRoot(node)
 const render=(filterCommand?:any)=>root.render(h(RemoteContext.Provider,{value:api as never},h(RecordPanel,{kind:'inventory-item-details',connectionId:'c',columns:['id'],onColumns:()=>{},onContext,...(filterCommand?{filterCommand}:{})})))
 try{
  await act(async()=>render())
  await act(async()=>render({id:'add',target:'filters',page:'inventory-item-details',queryFields:['product_code'],expiresAt:Date.now()+10000}))
  expect(node.textContent).toContain('产品（多选）')
  expect(recordList).toHaveBeenCalledTimes(1)
  await act(async()=>render({id:'query',target:'filters',page:'inventory-item-details',queryFields:['product_code'],products:[{id:'p',code:'PT-HEAD',name:'打印头'}],expiresAt:Date.now()+10000}))
  expect(recordList.mock.lastCall?.[0]).toMatchObject({productIds:['p'],page:1})
  expect(onContext.mock.lastCall?.[0].productIds).toEqual(['p'])
  await act(async()=>Array.from(node.querySelectorAll('button')).find(b=>b.textContent==='清空条件')!.click())
  expect(recordList.mock.lastCall?.[0]).toMatchObject({productIds:[],query:'',page:1})
 }finally{await act(async()=>root.unmount())}
})

it('restores Chat query fields and products on remount, refetches data, and isolates identities',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true
 localStorage.clear()
 const {PreferenceScope}=await import('./view-preferences.js')
 const recordList=vi.fn(async()=>({rows:[],page:1,pages:1,total:0,fetchedAt:''})),onContext=vi.fn()
 const node=document.createElement('div');let root=createRoot(node)
 const render=(scope:string,filterCommand?:any)=>root.render(h(PreferenceScope.Provider,{value:scope},h(RemoteContext.Provider,{value:{recordList,recordFilterFields:vi.fn(async()=>[{name:'inventory_item_id',type:'string'},{name:'reason',type:'string'},{name:'include_archived_items',type:'boolean'}])} as never},h(RecordPanel,{kind:'inventory-item-details',connectionId:scope,columns:['id'],onColumns:()=>{},onContext,...(filterCommand?{filterCommand}:{})}))))
 await act(async()=>render('tenant-a:user-a',{id:'query',target:'filters',page:'inventory-item-details',queryFields:['product_code'],products:[{id:'p',code:'PT-HEAD',name:'打印头'}],expiresAt:Date.now()+10000}))
 await act(async()=>root.unmount())
 root=createRoot(node)
 await act(async()=>render('tenant-a:user-a'))
 expect(node.textContent).toContain('产品（多选）')
 expect(recordList.mock.lastCall?.[0]).toMatchObject({productIds:['p']})
 expect(onContext.mock.lastCall?.[0].queryFields).toEqual(['product_code'])
 await act(async()=>render('tenant-b:user-a'))
 expect(node.textContent).not.toContain('产品（多选）')
 expect(recordList.mock.lastCall?.[0]).toMatchObject({productIds:[]})
 await act(async()=>render('tenant-a:user-a'))
 await act(async()=>Array.from(node.querySelectorAll('button')).find(b=>b.textContent==='清空条件')!.click())
 await act(async()=>root.unmount())
 root=createRoot(node)
 await act(async()=>render('tenant-a:user-a'))
 expect(recordList.mock.lastCall?.[0]).toMatchObject({productIds:[]})
 await act(async()=>root.unmount())
})

it('offers only query fields the endpoint declares, and sends their values to the server',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true
 localStorage.clear()
 const recordList=vi.fn(async()=>({rows:[],page:1,pages:1,total:0,fetchedAt:''})),onContext=vi.fn()
 // What GET /inventory-item-details declares on a real deployment: no effective-date parameter.
 const recordFilterFields=vi.fn(async()=>[{name:'inventory_item_id',type:'string'},{name:'reason',type:'string'},{name:'include_archived_items',type:'boolean'}])
 // One stable Remote, as useOryhRemote gives the page: a fresh object per render would re-run every query.
 const api={recordList,recordFilterFields}
 const node=document.createElement('div'),root=createRoot(node)
 const render=(filterCommand?:any)=>root.render(h(RemoteContext.Provider,{value:api as never},h(RecordPanel,{kind:'inventory-item-details',connectionId:'c',columns:['id'],onColumns:()=>{},onContext,...(filterCommand?{filterCommand}:{})})))
 try{
  await act(async()=>render())
  const picker=()=>Array.from(node.querySelectorAll('details')).find(d=>d.querySelector('summary')?.textContent==='查询字段')
  const options=Array.from(picker()!.querySelectorAll('label')).map(l=>l.textContent)
  // Declared fields are offered under their column names; the search box's own field is not repeated.
  expect(options).toEqual(['产品','变动原因','include_archived_items'])
  // 生效时间 is a column, not a query parameter, so it is not offered as a query field.
  expect(options).not.toContain('生效时间')

  await act(async()=>render({id:'q',target:'filters',page:'inventory-item-details',queryFields:['reason'],queryValues:{reason:'sale'},expiresAt:Date.now()+10000}))
  expect(recordList.mock.lastCall?.[0]).toMatchObject({kind:'inventory-item-details',filters:{reason:'sale'},page:1})
  expect(onContext.mock.lastCall?.[0]).toMatchObject({queryFields:['reason'],queryValues:{reason:'sale'}})

  // One request per applied command, and never one sent before the values are in place: an unfiltered
  // read here would be a wasted call to ORYH, and for a product query up to a hundred of them.
  expect(recordList.mock.calls.map(c=>c[0].filters)).toEqual([undefined,{reason:'sale'}])

  // A command for another list is not this list's to apply.
  const calls=recordList.mock.calls.length
  await act(async()=>render({id:'other',target:'filters',page:'shipments',queryFields:['direction'],queryValues:{direction:'inbound'},expiresAt:Date.now()+10000}))
  expect(recordList.mock.calls.length).toBe(calls)
 }finally{await act(async()=>root.unmount())}
})
