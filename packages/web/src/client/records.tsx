import {useViewPreference,textPreference,pagePreference,productPreference,queryFieldsPreference,queryValuesPreference,PreferenceDetails} from './view-preferences.js'
import {ProductPicker} from './product-picker.js'
import {recordColumns,recordDefaultColumns,recordSpecs} from '@oryh/ai-client-records'
import type {ChatNavigation,UserViewSummary} from '@oryh/dsh-host/types'
import {useEffect,useRef,useState} from 'react'
import {Button,Field,Input} from '@fluentui/react-components'
import type {RecordKind,RecordPage,BusinessRecord,ProductOption,RecordFilterField} from '@oryh/ai-client-records'
import type {PageContext} from './workbench.js'
import {useOryhRemote} from './remote.js'
import {useServerRefresh} from './command-stream.js'
import {BackToList,ClearConditionsButton,EmptyState,ErrorNote,ListFooter,ListLoading,PageHeader,RefreshButton,RowOpenCell,RowOpenHeader,StatusPill,formatDateTime,formatDisplayValue} from './list-kit.js'
import {useText} from './locale.js'
import {pageLabels} from './page-labels.js'
import {statusLabel,statusTone} from './status-words.js'
export const isRecordKind=(value:string):value is RecordKind=>Object.hasOwn(recordSpecs,value)
const queryLabels:Record<RecordKind,string>={'sales-orders':'订单号、名称或客户关键词','inventory-items':'仓库名称（精确匹配）','inventory-item-details':'库存项编号（精确匹配）',shipments:'单号、承运商或运单关键词'}
/**
 * One ORYH list, either as a built-in page or as a menu entry the person made.
 *
 * A menu entry (`view`) is the same list narrowed by filters the SERVER applies. It keeps its own
 * paging and search so it never disturbs the plain list, and it reports the underlying list as the
 * page so the Host's permission check and the column tool treat it exactly like that list.
 */
export function RecordPanel({kind,view,filterCommand,columns,onColumns,connectionId,onContext}:{filterCommand?:ChatNavigation;view?:UserViewSummary;columns:string[];onColumns:(columns:string[])=>void;kind:RecordKind;connectionId:string;onContext:(value:PageContext)=>void}){
 const catalog=recordColumns(kind)
 const api=useOryhRemote(),text=useText(),callback=useRef(onContext);callback.current=onContext
 const scope=view?`view:${view.id}`:kind,listTitle=text(pageLabels[kind]),title=view?.label??listTitle,filterText=view?Object.entries(view.filters).map(([k,v])=>`${k} = ${v}`).join('，'):''
 const [data,setData]=useState<RecordPage>(),[selected,setSelected]=useState<BusinessRecord>(),[page,setPage]=useViewPreference(`${scope}:page`,1,pagePreference),[query,setQuery]=useViewPreference(`${scope}:query`,'',textPreference),[search,setSearch]=useViewPreference(`${scope}:search`,'',textPreference),[reload,setReload]=useState(0),[busy,setBusy]=useState(true),[error,setError]=useState('')
 const [queryFields,setQueryFields]=useViewPreference<string[]>(`${kind}:queryFields`,[],queryFieldsPreference),[products,setProducts]=useViewPreference<ProductOption[]>(`${kind}:products`,[],productPreference),[appliedProducts,setAppliedProducts]=useViewPreference<ProductOption[]>(`${kind}:appliedProducts`,[],productPreference)
 const [values,setValues]=useViewPreference<Record<string,string>>(`${kind}:queryValues`,{},queryValuesPreference),[appliedValues,setAppliedValues]=useViewPreference<Record<string,string>>(`${kind}:appliedQueryValues`,{},queryValuesPreference)
 // What this list can be queried by is the deployment's answer, read from its own OpenAPI. Until it
 // arrives nothing extra is offered, and a saved field the endpoint no longer declares is dropped.
 const [declared,setDeclared]=useState<RecordFilterField[]>()
 useEffect(()=>{if(view){setDeclared([]);return}let live=true;setDeclared(undefined);void api.recordFilterFields(connectionId,kind).then(fields=>{if(live)setDeclared(fields)},()=>{if(live)setDeclared([])});return()=>{live=false}},[api,connectionId,kind,view])
 const searchField=recordSpecs[kind].query
 // The search box already owns its field; product_code is a query this client composes for movements.
 const availableFields:{id:string;label:string;type:RecordFilterField['type']|'product'}[]=[...(kind==='inventory-item-details'?[{id:'product_code',label:'产品',type:'product' as const}]:[]),...(declared??[]).filter(f=>f.name!==searchField).map(f=>({id:f.name,label:catalog[f.name]??f.name,type:f.type}))]
 const shownFields=declared===undefined?queryFields:queryFields.filter(id=>availableFields.some(f=>f.id===id))
 const activeValues=Object.fromEntries(Object.entries(appliedValues).filter(([id,value])=>value&&id!=='product_code'&&shownFields.includes(id)))
 const activeKey=JSON.stringify(activeValues)
 const handledFilter=useRef('')
 // After a write made in Chat the list re-reads in place: the rows stay on screen, and an open record
 // stays open with its new values instead of closing as a fresh query would.
 const softReload=useRef(false)
 useServerRefresh(true,()=>{softReload.current=true;setReload(v=>v+1)})
 function configureFields(fields:string[]){
  const keep=(v:Record<string,string>)=>Object.fromEntries(Object.entries(v).filter(([id])=>fields.includes(id)))
  setQueryFields(fields);setValues(keep(values));setAppliedValues(keep(appliedValues))
  if(!fields.includes('product_code')){setProducts([]);setAppliedProducts([])}
  setPage(1)
 }
 useEffect(()=>{
  if(view||!filterCommand||filterCommand.id===handledFilter.current||filterCommand.expiresAt<Date.now()||filterCommand.page!==kind)return
  handledFilter.current=filterCommand.id;configureFields(filterCommand.queryFields??[])
  if(filterCommand.queryValues!==undefined){setValues(filterCommand.queryValues);setAppliedValues(filterCommand.queryValues)}
  if(filterCommand.products!==undefined){setProducts(filterCommand.products);setAppliedProducts(filterCommand.products)}
  // No reload bump here: changed values or products already re-run the query through its dependencies,
  // and the extra counter sent the same request a second time.
  if(filterCommand.queryValues!==undefined||filterCommand.products!==undefined){setSearch(query);setPage(1)}
 },[filterCommand,kind,view])
 useEffect(()=>{let live=true;const soft=softReload.current;softReload.current=false;if(!soft){setBusy(true);setData(undefined);setSelected(undefined)}setError('');void api.recordList({connectionId,kind,page,query:search,...(view?{filters:view.filters}:{...(kind==='inventory-item-details'?{productIds:appliedProducts.map(p=>p.id)}:{}),...(Object.keys(activeValues).length?{filters:activeValues}:{})})}).then(value=>{if(live){setData(value);if(soft)setSelected(current=>current&&(value.rows.find(row=>row.id===current.id)??current));if(page>Math.max(1,value.pages))setPage(Math.max(1,value.pages))}}).catch(e=>{if(live)setError(e instanceof Error?e.message:'查询失败')}).finally(()=>{if(live)setBusy(false)});return()=>{live=false}},[api,connectionId,kind,view,page,search,reload,appliedProducts,activeKey])
 useEffect(()=>{callback.current({key:`${kind}:${selected?.id??'list'}`,title:selected?.title??title,detail:[filterText&&`筛选：${filterText}`,search].filter(Boolean).join(' · ')||'默认查询',scope:view?'用户菜单项 · 服务端筛选 · 只读':appliedProducts.length?'产品关联查询 · 只读':'服务端分页 · 只读',...(view?{view}:{}),queryFields,queryValues:activeValues,productIds:appliedProducts.map(p=>p.id),columns,availableColumns:Object.entries(catalog).map(([id,label])=>({id,label})),content:JSON.stringify({loading:busy,error,page: data?.page??page,pages:data?.pages,total:data?.total,query:search,productIds:appliedProducts.map(p=>p.id),queryDraft:{[searchField]:query,products,values},queryValues:activeValues,availableQueryFields:availableFields.map(({id,label,type})=>({id,label,type})),fetchedAt:data?.fetchedAt,selected,visibleRows:selected?[]:data?.rows??[]})})},[kind,view,selected,busy,error,page,search,data,columns,queryFields,appliedProducts,query,products,values,activeKey,declared])
 return <section className="business-page oryh-records" aria-busy={busy}>
  {selected?<PageHeader back={<BackToList onClick={()=>setSelected(undefined)}/>} title={selected.title}/>:<PageHeader title={title} actions={<RefreshButton disabled={busy} onClick={()=>setReload(v=>v+1)}/>}/>}
  {view&&!selected&&<p className="data-caption">{listTitle} · 筛选：{filterText}</p>}
  {error&&<ErrorNote message={error} disabled={busy} onRetry={()=>setReload(v=>v+1)}/>}
  {selected?<div className="surface document-detail"><h2>记录信息</h2><p className="data-caption">来源：ORYH · 查询时间：{data?.fetchedAt&&formatDateTime(data.fetchedAt)}</p><dl className="document-fields">{selected.fields.map(f=><div key={f.label}><dt>{f.label}</dt><dd>{f.label===catalog.status?statusLabel(f.value):formatDisplayValue(f.value)}</dd></div>)}</dl></div>:<>
   <section className="surface table-surface"><form className="record-search" onSubmit={e=>{e.preventDefault();setPage(1);setSearch(query);setAppliedProducts(products);setAppliedValues(values);setReload(v=>v+1)}}><Field label={queryLabels[kind]}><Input value={query} onChange={(_,d)=>setQuery(d.value)} maxLength={200}/></Field>{!view&&shownFields.map(id=>{const field=availableFields.find(f=>f.id===id);if(!field)return null
      if(field.type==='product')return <Field key={id} label={`${field.label}（多选）`}><ProductPicker connectionId={connectionId} value={products} onChange={setProducts}/></Field>
      if(field.type==='boolean')return <Field key={id} label={field.label}><select value={values[id]??''} onChange={e=>setValues({...values,[id]:e.target.value})}><option value="">全部</option><option value="true">是</option><option value="false">否</option></select></Field>
      return <Field key={id} label={field.label}><Input value={values[id]??''} maxLength={200} onChange={(_,d)=>setValues({...values,[id]:d.value})}/></Field>})}<Button type="submit" disabled={busy}>查询</Button><ClearConditionsButton onClick={()=>{setQuery('');setSearch('');setProducts([]);setAppliedProducts([]);setValues({});setAppliedValues({});setPage(1);setReload(v=>v+1)}}/></form>
   <div className="list-configuration">{!view&&availableFields.length>0&&<PreferenceDetails preferenceKey={`${kind}:fieldsOpen`} className="advanced-filters"><summary>查询字段</summary><div className="project-column-options">{availableFields.map(f=><label key={f.id}><input type="checkbox" checked={queryFields.includes(f.id)} onChange={e=>configureFields(e.target.checked?[...queryFields,f.id]:queryFields.filter(x=>x!==f.id))}/>{f.label}</label>)}</div></PreferenceDetails>}
   <PreferenceDetails preferenceKey={`${kind}:columnsOpen`} className="advanced-filters"><summary>显示列</summary><div className="project-column-options">{Object.entries(catalog).map(([id,label])=><label key={id}><input type="checkbox" checked={columns.includes(id)} disabled={columns.length===1&&columns.includes(id)} onChange={e=>onColumns(e.target.checked?[...columns,id]:columns.filter(c=>c!==id))}/>{label}</label>)}<Button size="small" appearance="subtle" onClick={()=>onColumns([...recordDefaultColumns[kind]])}>恢复默认列</Button></div></PreferenceDetails>
   </div>{kind==='inventory-item-details'&&<p className="data-caption">库存流水为追加记录；默认查询活动库存项，指定库存项编号可查看其历史。</p>}
   {busy?<ListLoading/>:data&&<div><div className="table-scroll"><table><thead><tr>{columns.map(c=><th scope="col" key={c}>{catalog[c]}</th>)}<RowOpenHeader/></tr></thead><tbody>{data.rows.map(row=>{const cell=(c:string)=>formatDisplayValue(row.fields.find(f=>f.label===catalog[c])?.value??'—');return <tr key={row.id}>{columns.map((c,index)=><td key={c}>{index===0?<button className="record-link" onClick={()=>setSelected(row)}>{cell(c)}</button>:c==='status'&&cell(c)!=='—'?<StatusPill tone={statusTone(cell(c))}>{statusLabel(cell(c))}</StatusPill>:cell(c)}</td>)}<RowOpenCell title={row.title||cell(columns[0]!)} onOpen={()=>setSelected(row)}/></tr>})}</tbody></table></div>{!data.rows.length&&<EmptyState filtered={Boolean(search||view||Object.keys(activeValues).length||appliedProducts.length)}/>}<ListFooter count={data.total} page={page} pages={data.pages} onPage={setPage}/></div>}
  </section></>}
 </section>
}
