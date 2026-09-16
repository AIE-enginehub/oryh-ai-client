import {createContext, useContext, useMemo, useSyncExternalStore, type SetStateAction, type ComponentProps} from 'react'
import {createSnapshotStore} from '@deepseek-ai/dsh-client-store'
import {z} from 'zod'

export const PreferenceScope = createContext<string | undefined>(undefined)
export const textPreference = z.string().max(2000).catch('')
export const pagePreference = z.number().int().min(1).max(1000000).catch(1)
export const booleanPreference = z.boolean().catch(false)
export const filterPreference = z.object({text:textPreference,status:textPreference,from:textPreference,to:textPreference,descending:z.boolean().catch(true)}).catch({text:'',status:'',from:'',to:'',descending:true})
export const productPreference = z.array(z.object({id:z.string().max(200),name:z.string().max(1000),code:z.string().max(1000)})).max(50).catch([])
// Field names only. Which fields a list really accepts is the deployment's answer, checked when the page
// loads them — this schema must not decide it, or it becomes one more hardcoded list.
export const queryFieldsPreference = z.array(z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/)).max(20).transform(v=>[...new Set(v)]).catch([])
/** Query-field values keyed by field name; empty values are dropped rather than sent. */
export const queryValuesPreference = z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/), z.string().max(200)).catch({})

export function createViewPreference<T>(scope:string|undefined,key:string,initial:T,schema:z.ZodType<T>) {
 const store=createSnapshotStore<T>(initial,scope===undefined?undefined:{persist:{name:`oryh.view.v1:${scope}:${key}`}})
 const normalize=(value:unknown):T=>{const result=schema.safeParse(value);return result.success?result.data:initial}
 store.set(normalize(store.getSnapshot()))
 return {getSnapshot:store.getSnapshot,subscribe:store.subscribe,set:(next:SetStateAction<T>)=>store.set(normalize(typeof next==='function'?(next as (v:T)=>T)(store.getSnapshot()):next))}
}
export function useViewPreference<T>(key:string,initial:T,schema:z.ZodType<T>) {
 const scope=useContext(PreferenceScope)
 const store=useMemo(()=>createViewPreference(scope,key,initial,schema),[scope,key,schema])
 return [useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),store.set] as const
}
export function PreferenceDetails({preferenceKey,...props}:ComponentProps<'details'>&{preferenceKey:string}) {
 const [open,setOpen]=useViewPreference(preferenceKey,false,booleanPreference)
 return <details {...props} open={open} onToggle={e=>{setOpen(e.currentTarget.open);props.onToggle?.(e)}}/>
}
