import {useEffect,useState} from 'react'
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,Input} from '@fluentui/react-components'
import type {ProductOption,ProductOptions} from '@oryh/ai-client-records'
import {useOryhRemote} from './remote.js'
const SearchIcon=()=> <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
export function ProductPicker({connectionId,value,onChange}:{connectionId:string;value:ProductOption[];onChange:(value:ProductOption[])=>void}){
 const api=useOryhRemote()
 const [open,setOpen]=useState(false),[draft,setDraft]=useState<ProductOption[]>([]),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1),[reload,setReload]=useState(0),[data,setData]=useState<ProductOptions>(),[busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>setOpen(false),[value,connectionId])
 useEffect(()=>{if(!open)return;let live=true;setBusy(true);setError('');setData(undefined)
  void api.productSearch({connectionId,query:search,page}).then(v=>{if(live)setData(v)}).catch(e=>{if(live)setError(e instanceof Error?e.message:'产品搜索失败')}).finally(()=>{if(live)setBusy(false)})
  return()=>{live=false}
 },[api,connectionId,open,search,page,reload])
 function show(){setDraft([...value]);setQuery('');setSearch('');setPage(1);setOpen(true)}
 return <div className="product-picker">
  <div className="product-picker-control"><span>{value.length?`已选 ${value.length} 个产品`:'全部产品'}</span><Button type="button" appearance="subtle" aria-label="搜索并选择产品" onClick={show}><SearchIcon/></Button></div>
  {value.length>0&&<div className="product-chips">{value.map(p=><span key={p.id} className="product-chip" title={p.name}>{p.code||p.name}<button type="button" aria-label={`移除 ${p.name}`} onClick={()=>onChange(value.filter(v=>v.id!==p.id))}>×</button></span>)}</div>}
  <Dialog open={open} onOpenChange={(_,d)=>setOpen(d.open)}><DialogSurface className="product-picker-dialog"><DialogBody><DialogTitle>选择产品</DialogTitle><DialogContent>
   <form className="product-picker-search" onSubmit={e=>{e.preventDefault();e.stopPropagation();setSearch(query.trim());setPage(1);setReload(v=>v+1)}}><Input aria-label="搜索产品名称或编码" placeholder="输入产品名称或编码" value={query} onChange={(_,d)=>setQuery(d.value)} maxLength={200}/><Button type="submit" disabled={busy}>搜索</Button></form>
   <div className="product-picker-selection"><span>已选 {draft.length} / 50</span><Button type="button" appearance="subtle" size="small" onClick={()=>setDraft([])}>清空选择</Button></div>
   {draft.length>0&&<div className="product-chips">{draft.map(p=><span key={p.id} className="product-chip">{p.code||p.name}<button type="button" aria-label={`取消选择 ${p.name}`} onClick={()=>setDraft(v=>v.filter(x=>x.id!==p.id))}>×</button></span>)}</div>}
   {error&&<p role="alert">{error}</p>}{busy?<p role="status">正在搜索产品…</p>:data&&<><div className="product-picker-results">{data.rows.map(p=><label className="product-picker-row" key={p.id}><input type="checkbox" checked={draft.some(v=>v.id===p.id)} disabled={draft.length>=50&&!draft.some(v=>v.id===p.id)} onChange={e=>setDraft(v=>e.target.checked?[...v,p]:v.filter(x=>x.id!==p.id))}/><span><strong>{p.name}</strong><small>{p.code||'无产品编码'}</small></span></label>)}{!data.rows.length&&<p>没有匹配的产品</p>}</div><div className="product-picker-pagination"><span>共 {data.total} 个产品</span><Button type="button" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页</Button><span>{page} / {data.pages}</span><Button type="button" disabled={page>=data.pages} onClick={()=>setPage(p=>p+1)}>下一页</Button></div></>}
  </DialogContent><DialogActions><Button type="button" onClick={()=>setOpen(false)}>取消</Button><Button type="button" appearance="primary" onClick={()=>{onChange(draft);setOpen(false)}}>确定选择（{draft.length}）</Button></DialogActions></DialogBody></DialogSurface></Dialog>
 </div>
}
