import { OryhClientError, connectionId, pageOperation, type ConnectionId, type OryhOperation } from '@oryh/ai-client-foundation'
import { hasPermission } from '@oryh/ai-client-pages'
import { createHash, randomUUID } from 'node:crypto'
import type { ProjectFields, ProjectIntent, OryhProjectRemote } from './contracts.js'

/** The transport this service needs. Project creation writes, so the request shape is the full one. */
export interface ProjectHttp {
 request(connectionId:ConnectionId,request:{
  readonly path:`/${string}`
  readonly method?:'GET'|'POST'|'PATCH'|'DELETE'
  readonly body?:unknown
  readonly retryExpired?:boolean
  /** On the server, how this write was confirmed; the desktop transport ignores it. */
  readonly operation?:OryhOperation
 }):Promise<unknown>
}

/** The connection facts this service reads; `ConnectionSummary` satisfies this shape. */
export interface ProjectConnection {
 readonly origin:string
 readonly identity:{
  readonly permissions?:readonly string[]
  readonly user:{readonly id:string;readonly employeeId:string|null}
  readonly tenant:{readonly id:string}
 }
}

export interface ProjectRecord extends ProjectIntent {scope:string}
export interface ProjectStore {list():Promise<ProjectRecord[]>;append(record:ProjectRecord,previousRevision:number):Promise<void>}
const fail=(text:string)=>new OryhClientError(text,'request-failed')
/**
 * Narrow a response fragment to an object.
 *
 * Borrowed from the expense contracts before this domain was extracted, so a malformed
 * project response reported an expense conflict. It now raises this service's own
 * `request-failed`. No test or consumer observed the old code.
 * @param value - decoded response fragment.
 * @returns the value as a record.
 */
const object=(value:unknown):Record<string,unknown>=>{
 if(value===null||typeof value!=='object'||Array.isArray(value))throw fail('项目数据无效。')
 return value as Record<string,unknown>
}
export function validateProject(f:ProjectFields,complete=true){
 for(const [key,max]of [['project_name',200],['project_code',64],['client',200],['start_date',10],['end_date',10]] as const)if(typeof f[key]!=='string'||f[key].length>max)throw fail('项目字段格式或长度无效。')
 if(complete&&!f.project_name.trim())throw fail('请填写项目名称。')
 for(const d of [f.start_date,f.end_date])if(d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))throw fail('项目日期无效。')
 if(f.start_date&&f.end_date&&f.start_date>f.end_date)throw fail('结束日期不能早于开始日期。')
}
export class ProjectService implements OryhProjectRemote {
 constructor(private store:ProjectStore,private http:ProjectHttp,private connection:(id:string)=>ProjectConnection,private verify:(id:string)=>Promise<ProjectConnection>){}
 private scope(id:string){const c=this.connection(id);return JSON.stringify([c.origin,c.identity.tenant.id,c.identity.user.id])}
 private guard(id:string,scope:string){if(this.scope(id)!==scope)throw fail('企业或用户身份已改变。')}
 async projectOptions(id:string){await this.verify(id);const scope=this.scope(id);const me=object(object(await this.http.request(connectionId(id),{path:'/auth/me'})).data);this.guard(id,scope);const p=me.permissions;return {canCreate:Array.isArray(p)&&['master_data.manage','users.manage'].some(v=>hasPermission({...this.connection(id).identity,permissions:p.filter((x):x is string=>typeof x==='string')},v))}}
 private async authorize(id:string){if(!(await this.projectOptions(id)).canCreate)throw fail('当前账号没有创建项目的主数据管理权限。')}
 private async all(id:string){const scope=this.scope(id),result:Record<string,unknown>[]=[];for(let page=1;page<=1000;page++){const body=object(await this.http.request(connectionId(id),{path:`/projects?page=${page}&size=100`}));this.guard(id,scope);if(!Array.isArray(body.data))throw fail('项目列表响应无效。');result.push(...body.data.map(object));if(page>=Number(object(body.meta??{}).pages??1))return result}throw fail('项目记录过多，无法安全核对。')}
 private view(r:ProjectRecord):ProjectIntent {const {scope,...v}=r;return v.state==='creating'?{...v,state:'unknown',message:'创建结果尚未确认，请核对服务端结果。'}:v}
 async projectHistory(id:string){await this.verify(id);const scope=this.scope(id),rows=await this.store.list();this.guard(id,scope);return rows.filter(r=>r.scope===scope).map(r=>this.view(r)).reverse()}
 async projectPrepare(id:string,input:ProjectFields){
  await this.authorize(id);validateProject(input);const scope=this.scope(id),rows=await this.store.list();this.guard(id,scope)
  if(rows.some(r=>r.scope===scope&&['creating','unknown'].includes(r.state)))throw fail('有项目创建结果尚未确认，请先核对执行记录，勿重复创建。')
  const fields=structuredClone(input);fields.project_name=fields.project_name.trim();fields.project_code=fields.project_code.trim()||`ORYH-${randomUUID()}`
  if((await this.all(id)).some(p=>p.project_code===fields.project_code))throw fail('项目编码已存在，请更换编码或查看已有项目。')
  const r:ProjectRecord={id:randomUUID(),revision:1,scope,fields,state:'review',token:randomUUID(),expiresAt:Date.now()+300000,message:'尚未创建，请核对后确认。'}
  this.guard(id,scope);await this.store.append(r,0);return this.view(r)
 }
 private async record(id:string,key:string,revision:number){const scope=this.scope(id);const r=(await this.store.list()).find(r=>r.scope===scope&&r.id===key&&r.revision===revision);this.guard(id,scope);if(!r)throw fail('执行记录已改变，请刷新。');return r}
 private async next(id:string,r:ProjectRecord,change:Partial<ProjectRecord>){this.guard(id,r.scope);const n={...r,...change,revision:r.revision+1};await this.store.append(n,r.revision);return n}
 async projectConfirm(id:string,key:string,revision:number,token:string){
  await this.authorize(id);let r=await this.record(id,key,revision)
  if(r.state!=='review'||r.token!==token||r.expiresAt<Date.now())throw fail('确认已过期或已经使用，请重新核对。')
  validateProject(r.fields)
  // Durable compare-and-append consumes confirmation before any POST. Never auto-replay writes.
  r=await this.next(id,r,{state:'creating',token:'',message:'正在创建项目。'})
  try{
   this.guard(id,r.scope)
   const f=r.fields,write={path:'/projects' as const,method:'POST' as const,body:{project_name:f.project_name,project_code:f.project_code,client:f.client||null,start_date:f.start_date||null,end_date:f.end_date||null,status:'active',metadata:{oryh_client_intent_id:r.id}}}
   const body=object(await this.http.request(connectionId(id),{...write,retryExpired:false,operation:pageOperation(`${r.id}:create`,write,text=>createHash('sha256').update(text).digest('hex'))}))
   this.guard(id,r.scope);const data=object(body.data)
   if(typeof data.id!=='string'||!this.matches(data,r))throw fail('项目创建回执不匹配，请核对结果。')
   return this.view(await this.next(id,r,{state:'created',projectId:data.id,message:'项目已创建。'}))
  }catch(e){
   const rejected=e instanceof OryhClientError&&[400,401,403,404,409,422].includes(e.status??0)
   return this.view(await this.next(id,r,{state:rejected?'failed':'unknown',message:rejected?(e.status===409?'项目编码冲突，未创建新项目。':'服务端拒绝创建，请核对权限和字段。'):'创建结果尚未确认，请核对服务端结果，勿重复创建。'}))
  }
 }
 private matches(p:Record<string,unknown>,r:ProjectRecord){const f=r.fields;return p.project_code===f.project_code&&p.project_name===f.project_name&&(p.client??'')===f.client&&(p.start_date??'')===f.start_date&&(p.end_date??'')===f.end_date&&object(p.metadata??{}).oryh_client_intent_id===r.id}
 async projectReconcile(id:string,key:string,revision:number){await this.verify(id);const r=await this.record(id,key,revision);if(!['creating','unknown'].includes(r.state))throw fail('这条记录不需要核对。');const matches=(await this.all(id)).filter(p=>this.matches(p,r));if(matches.length===1&&typeof matches[0]!.id==='string')return this.view(await this.next(id,r,{state:'created',projectId:matches[0]!.id,message:'已确认项目创建成功。'}));return this.view(r)}
}
