import {describe,it,expect,vi} from 'vitest'
import {ProjectChat} from '../src/project-chat.js'
import {CommandQueue} from '../src/command-queue.js'
import type {Context} from '@deepseek-ai/cordis'
import type {OryhProjectRemote} from '@oryh/ai-client-projects'
const fields={project_name:'Project',project_code:'',client:'Client',start_date:'',end_date:''}
const state={sessionId:'s',connectionId:'c' as never,pageKey:'page',revision:1,fields,busy:false}
function fixture(){let page=true;const prepare=vi.fn(),confirm=vi.fn();const p=new ProjectChat({} as Context,{projectOptions:async()=>({canCreate:true}),projectPrepare:prepare,projectConfirm:confirm} as unknown as OryhProjectRemote,()=>{if(!page)throw Error('left');return 'c'},new CommandQueue());p.sync(state);return {p,prepare,confirm,leave:()=>{page=false}}}
describe('project chat proposals',()=>{
 it('only updates local fields and waits for UI acknowledgement',async()=>{const f=fixture(),next={...fields,project_name:'Updated'};const pending=f.p.fill('s',1,next,new AbortController().signal);const suggestion=f.p.pending('s');expect(suggestion?.fields).toEqual(next);f.p.sync({...state,revision:2,fields:next});expect(await pending).toContain('尚未创建');expect(f.prepare).not.toHaveBeenCalled();expect(f.confirm).not.toHaveBeenCalled()})
 it('rejects stale revisions, busy forms, extra metadata and leaving the page',async()=>{const f=fixture();await expect(f.p.fill('s',0,fields,new AbortController().signal)).rejects.toThrow();await expect(f.p.fill('s',1,{...fields,metadata:{tenant:'other'}},new AbortController().signal)).rejects.toThrow();f.p.sync({...state,revision:2,busy:true});await expect(f.p.fill('s',2,fields,new AbortController().signal)).rejects.toThrow();f.leave();await expect(f.p.read('s')).rejects.toThrow('left')})
 it('does not claim an update if the user changes the form first',async()=>{const f=fixture(),pending=f.p.fill('s',1,{...fields,client:'AI'},new AbortController().signal);f.p.sync({...state,revision:2,fields:{...fields,client:'Human'}});await expect(pending).rejects.toThrow(/用户已修改/);expect(f.p.pending('s')).toBeUndefined()})
})
