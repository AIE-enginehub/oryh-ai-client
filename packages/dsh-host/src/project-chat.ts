import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {z} from 'zod'
import {OryhClientError} from '@oryh/ai-client-foundation'
import {validateProject,type OryhProjectRemote,type ProjectFields} from '@oryh/ai-client-projects'
import type {ProjectChatState,ProjectChatProposal} from './types.js'
import type {CommandQueue} from './command-queue.js'
const schema=z.object({project_name:z.string().max(200),project_code:z.string().max(64),client:z.string().max(200),start_date:z.string(),end_date:z.string()}).strict()
const fail=(s:string)=>new OryhClientError(s,'request-failed')
export class ProjectChat {
 private states=new Map<string,ProjectChatState>();private proposals=new Map<string,ProjectChatProposal>()
 constructor(private ctx:Context,private api:OryhProjectRemote|undefined,private identity:(session:string)=>string,private queue:CommandQueue){}
 current(id:string){return this.states.get(id)}
 /** The staged suggestion the command stream publishes for this session. */
 pending(id:string){return this.proposals.get(id)}
 clear(id:string){this.states.delete(id);this.proposals.delete(id);this.queue.changed(id)}
 sync(s:ProjectChatState){if(this.identity(s.sessionId)!==s.connectionId)throw fail('企业已切换。');const old=this.states.get(s.sessionId);if(old?.pageKey===s.pageKey&&old.revision>s.revision)return;this.states.set(s.sessionId,structuredClone(s));if(old?.revision!==s.revision)this.proposals.delete(s.sessionId);this.queue.settle(s.sessionId)}
 async read(id:string){const cid=this.identity(id),s=this.states.get(id);if(!s||!this.api)throw fail('新建项目表单尚未打开。');const options=await this.api.projectOptions(cid);if(this.states.get(id)!==s)throw fail('表单已变化，请重新读取。');return {revision:s.revision,fields:s.fields,busy:s.busy,options,notice:'这是未保存表单，项目尚未创建。'}}
 async fill(id:string,revision:number,input:unknown,signal:AbortSignal){
  this.identity(id);const s=this.states.get(id);if(!s||s.revision!==revision||s.busy)throw fail('表单版本已改变或正在核对，请重新读取。');const parsed=schema.safeParse(input);if(!parsed.success)throw fail('项目字段格式无效。');const fields=parsed.data;validateProject(fields,false)
  if(JSON.stringify(fields)===JSON.stringify(s.fields))return '当前表单已是这些内容，未创建项目。'
  const p={id:randomUUID(),revision,fields};this.proposals.set(id,p);this.queue.changed(id)
  try{return await this.queue.wait<string>(id,'project-form',{
   invalid:()=>{
    try{this.identity(id)}catch(error){return error instanceof Error?error.message:'企业已切换。'}
    const now=this.states.get(id)
    if(!now||now.pageKey!==s.pageKey)return '项目页面已关闭。'
    return now.revision>revision&&JSON.stringify(now.fields)!==JSON.stringify(fields)?'用户已修改表单，请重新读取。':undefined
   },
   until:()=>this.states.get(id)!.revision>revision?'中间栏新建项目表单已更新，尚未创建项目。':undefined,
   expired:'填写未获页面确认，请重新读取。',timeoutMs:10000,signal,
  })}finally{if(this.proposals.get(id)===p){this.proposals.delete(id);this.queue.changed(id)}}
 }
 install(){const output={schema:{type:'string'} as const,render:(_a:unknown,value:string)=>[{type:'text' as const,text:value}]}
  this.ctx.tools.register(defineTool({name:'oryh_project_read',description:'读取新建项目表单、版本和实际创建权限。仅返回未保存字段，不返回确认凭据。',parameters:{},output,execute:async(_a,e)=>{if(!e.agent)throw fail('需要会话');return JSON.stringify(await this.read(String(e.agent.id)))}}))
  this.ctx.tools.register(defineTool({name:'oryh_project_fill',description:'帮用户填写中间栏上未保存的新建项目表单；完整字段中未要求修改的内容保持不变。不会创建项目；在对话里直接创建项目请按对应的 skill 执行。日期用 YYYY-MM-DD，空字段用空字符串。',parameters:{revision:{type:'integer',required:true},fields:{type:'object',required:true,additionalProperties:false,properties:{project_name:{type:'string',required:true},project_code:{type:'string',required:true},client:{type:'string',required:true},start_date:{type:'string',required:true},end_date:{type:'string',required:true}}}},output,execute:async(a,e)=>{if(!e.agent)throw fail('需要会话');return this.fill(String(e.agent.id),a.revision,a.fields,e.signal)}}))
 }
}
