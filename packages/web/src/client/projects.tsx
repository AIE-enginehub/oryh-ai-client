import {PreferenceDetails} from './view-preferences.js'
import {useContext,useEffect,useRef,useState} from 'react'
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions} from '@fluentui/react-components'
import type {ConnectionSummary} from '@oryh/ai-client-core/types'
import type {ProjectFields,ProjectIntent} from '@oryh/ai-client-projects'
import type {ChatNavigation} from '@oryh/dsh-host/types'
import type {PageContext} from './workbench.js'
import {BusinessPage} from './business-page.js'
import {BusinessSessionContext} from './todo-chat.js'
import {useCommands} from './command-stream.js'
import {useOryhRemote} from './remote.js'
import {BackToList,ErrorNote,ListLoading,PageHeader,StatusPill} from './list-kit.js'
import {statusLabel} from './status-words.js'
const blank=():ProjectFields=>({project_name:'',project_code:'',client:'',start_date:'',end_date:''})
const labels:Record<keyof ProjectFields,string>={project_name:'项目名称',project_code:'项目编码',client:'客户',start_date:'开始日期',end_date:'结束日期'}
export function ProjectPanel({columns,onColumns,connection,active,navigation,onDirtyChange,onContext}:{columns?:import('@oryh/dsh-host/types').ProjectColumn[];onColumns?:(v:import('@oryh/dsh-host/types').ProjectColumn[])=>void;connection:ConnectionSummary;active:boolean;navigation?:ChatNavigation;onDirtyChange:(v:boolean)=>void;onContext:(v:PageContext)=>void}){
 const api=useOryhRemote(),sessionId=useContext(BusinessSessionContext),alive=useRef(true)
 const [editor,setEditor]=useState(false),[fields,setFields]=useState(blank),[busy,setBusy]=useState(false),[error,setError]=useState(''),[canCreate,setCanCreate]=useState(false),[loaded,setLoaded]=useState(false),[review,setReview]=useState<ProjectIntent>(),[history,setHistory]=useState<ProjectIntent[]>([]),[message,setMessage]=useState(''),[reload,setReload]=useState(0),[opened,setOpened]=useState<string>()
 const [pageKey]=useState(()=>crypto.randomUUID()),version=useRef({json:'',revision:0}),seen=useRef(''),handled=useRef(''),callback=useRef(onContext)
 callback.current=onContext
 const json=JSON.stringify({fields,opened,busy:busy||Boolean(review)})
 if(version.current.json!==json)version.current={json,revision:version.current.revision+1}
 const revision=version.current.revision
 async function run(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await fn()}catch(e){if(alive.current)setError(e instanceof Error?e.message:'项目操作失败。')}finally{if(alive.current)setBusy(false)}}
 async function load(){const options=await api.projectOptions(connection.id),log=await api.projectHistory(connection.id);if(alive.current){setCanCreate(options.canCreate);setHistory(log);setLoaded(true)}}
 useEffect(()=>{alive.current=true;void run(load);return()=>{alive.current=false}},[connection.id])
 useEffect(()=>{onDirtyChange(editor||busy);return()=>onDirtyChange(false)},[editor,busy,onDirtyChange])
 useEffect(()=>{if(!editor)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[editor])
 useEffect(()=>{if(!active||!navigation||!loaded||busy||handled.current===navigation.id)return;handled.current=navigation.id;if(!canCreate){setError('当前账号没有创建项目权限。');return}setEditor(true);setOpened(navigation.id)},[active,navigation,loaded,busy,canCreate])
 useEffect(()=>{if(editor&&active)callback.current({key:'list-projects:new',title:'新建项目',detail:fields.project_name||'未填写项目名称',scope:'未保存表单'})},[editor,active,fields.project_name])
 useEffect(()=>{
  if(!active||!editor||!sessionId)return
  let live=true,timer:ReturnType<typeof setTimeout>|undefined
  async function sync(){try{await api.projectChatSync({sessionId:sessionId!,connectionId:connection.id,pageKey,revision,fields,busy:busy||Boolean(review),...(opened?{navigationId:opened}:{})})}catch{if(live)timer=setTimeout(()=>void sync(),350)}}
  void sync();return()=>{live=false;if(timer)clearTimeout(timer)}
 },[api,active,editor,sessionId,connection.id,pageKey,revision])
 const suggestion=useCommands().commands.project
 useEffect(()=>{
  if(!active||!editor||!sessionId||!suggestion||suggestion.revision!==version.current.revision||suggestion.id===seen.current||busy||review)return
  seen.current=suggestion.id;setFields(suggestion.fields);setReview(undefined)
 },[active,editor,sessionId,suggestion,busy,review])
 useEffect(()=>()=>{if(sessionId)void api.projectChatClear(sessionId).catch(()=>{})},[api,sessionId,active,editor])
 const open=()=>{if(canCreate){setEditor(true);setFields(blank());setReview(undefined);setError('')}else setError('当前账号没有创建项目的主数据管理权限。')}
 return <section className="oryh-projects" aria-busy={busy}>
  {!loaded&&<ListLoading/>}{!editor&&loaded&&<BusinessPage {...(columns?{projectColumns:columns}:{})} {...(onColumns?{onProjectColumns:onColumns}:{})} key={reload} connection={connection} operationId="list-projects" active={active} onContext={v=>{if(!editor)callback.current(v)}} onNewExpense={undefined} onNewProject={open}/>}
  {message&&<p role="status">{message}</p>}
  {editor&&<>
   <PageHeader back={<BackToList disabled={busy||Boolean(review)} onClick={()=>{setEditor(false);setFields(blank());setOpened(undefined);setError('')}}/>} title="新建项目" status={<StatusPill>未保存</StatusPill>}/>
   <form className="project-form" onSubmit={e=>{e.preventDefault();void run(async()=>{const r=await api.projectPrepare(connection.id,fields);if(alive.current){setReview(r);setHistory(h=>[r,...h])}})}}>
    <fieldset disabled={busy||Boolean(review)||!canCreate}>
     <section className="project-form-section" aria-labelledby={`${pageKey}-basic`}>
      <div className="project-section-heading"><h2 id={`${pageKey}-basic`}>基本信息</h2><span>仅项目名称必填</span></div>
      <div className="project-fields">
       {(['project_name','project_code','client'] as const).map(key=><label className={key==='project_name'?'project-field project-field-wide':'project-field'} key={key}>
        <span>{labels[key]}{key==='project_name'&&<span className="project-required" aria-hidden="true"> *</span>}</span>
        <input required={key==='project_name'} maxLength={key==='project_code'?64:200} placeholder={key==='project_name'?'输入项目名称':key==='project_code'?'自动生成':'输入客户名称'} value={fields[key]} onChange={e=>{setFields({...fields,[key]:e.target.value});setReview(undefined)}}/>
        {key==='project_code'&&<small>可自行填写，留空则自动生成</small>}
       </label>)}
      </div>
     </section>
     <section className="project-form-section" aria-labelledby={`${pageKey}-schedule`}>
      <div className="project-section-heading"><h2 id={`${pageKey}-schedule`}>项目周期</h2><span>选填</span></div>
      <div className="project-fields project-date-fields">{(['start_date','end_date'] as const).map(key=><label className="project-field" key={key}><span>{labels[key]}</span><input type="date" value={fields[key]} onChange={e=>{setFields({...fields,[key]:e.target.value});setReview(undefined)}}/></label>)}</div>
     </section>
     <div className="project-initial-status"><span>创建后状态</span><strong><i aria-hidden="true"/>{statusLabel('active')}</strong></div>
     {error&&!review&&<p className="project-form-error" role="alert">{error}</p>}
     <footer className="project-form-actions"><span>核对后确认创建</span><Button appearance="primary" type="submit">{busy?'正在核对…':'核对并创建'}</Button></footer>
    </fieldset>
   </form>
  </>}

  {!editor&&error&&<ErrorNote message={error}/>}
  {history.length>0&&<PreferenceDetails preferenceKey="projects:historyOpen" className="surface"><summary>项目执行记录</summary>{history.map(r=><div key={r.id}><p>{r.fields.project_name} · {r.message}{r.projectId&&<> · 项目编号：{r.projectId}</>}</p>{['unknown','creating'].includes(r.state)&&<Button disabled={busy} onClick={()=>void run(async()=>{const n=await api.projectReconcile(connection.id,r.id,r.revision);if(alive.current){setHistory(h=>h.map(x=>x.id===n.id?n:x));setMessage(n.message);if(n.state==='created'){setEditor(false);setReload(v=>v+1)}}})}>核对服务端结果</Button>}</div>)}</PreferenceDetails>}
  <Dialog open={Boolean(review)} onOpenChange={(_,d)=>{if(!d.open&&!busy)setReview(undefined)}}><DialogSurface className="oryh-project-review"><DialogBody><DialogTitle>确认创建项目</DialogTitle><DialogContent><p>{connection.identity.tenant.name??connection.identity.tenant.slug} · {connection.identity.user.email}</p>{review&&<dl>{(Object.keys(labels) as (keyof ProjectFields)[]).map(k=><div key={k}><dt>{labels[k]}</dt><dd>{review.fields[k]||'未填写'}</dd></div>)}</dl>}<p>确认后将在 ORYH 创建项目。</p>{error&&<p role="alert">{error}</p>}</DialogContent><DialogActions><Button disabled={busy} onClick={()=>setReview(undefined)}>返回修改</Button><Button appearance="primary" disabled={busy||!review||review.expiresAt<Date.now()} onClick={()=>void run(async()=>{if(!review)return;const n=await api.projectConfirm(connection.id,review.id,review.revision,review.token);if(alive.current){setReview(undefined);setHistory(h=>h.map(x=>x.id===n.id?n:x));setMessage(n.message);if(n.state==='created'){setEditor(false);setFields(blank());setOpened(undefined);setReload(v=>v+1)}}})}>{busy?'正在创建…':'确认创建'}</Button></DialogActions></DialogBody></DialogSurface></Dialog>
 </section>
}
