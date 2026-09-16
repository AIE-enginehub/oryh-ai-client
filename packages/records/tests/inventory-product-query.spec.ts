import {it,expect,vi} from 'vitest'
import {inventoryProductQuery} from '../src/inventory-product-query.js'
const query={connectionId:'c',kind:'inventory-item-details' as const,page:1,query:'',productCode:'P-1'}
it('finds products beyond the first position page and merges all matching ledger pages before pagination',async()=>{
 const read=vi.fn(async(path:string)=>{
  const u=new URL(path,'https://example.invalid'),page=Number(u.searchParams.get('page'))
  if(u.pathname==='/inventory-items')return {data:page===1?[{id:'other',product_code:'OTHER'}]:[{id:'a',product_code:'P-1'},{id:'b',product_code:'P-1'}],meta:{total:3,pages:2}}
  const id=u.searchParams.get('inventory_item_id')
  if(id==='a')return {data:[{id:`a${page}`,effective_at:`2026-01-0${page}`}],meta:{total:2,pages:2}}
  return {data:[{id:'b1',effective_at:'2026-01-03'}],meta:{total:1,pages:1}}
 })
 const result=await inventoryProductQuery(query,read)
 expect(result.data.map(r=>r.id)).toEqual(['b1','a2','a1'])
 expect(result.meta.total).toBe(3)
 expect(read.mock.calls[0]![0]).toContain('status=active')
 expect(read).toHaveBeenCalledTimes(5)
})
it('does not fetch unrelated ledger entries and preserves exact item AND product conditions',async()=>{
 const read=vi.fn(async()=>({data:{id:'a/b',product_code:'OTHER'}}))
 expect((await inventoryProductQuery({...query,query:'a/b'},read)).meta.total).toBe(0)
 expect(read).toHaveBeenCalledExactlyOnceWith('/inventory-items/a%2Fb')
})
it('rejects incomplete pagination instead of presenting a partial count',async()=>{
 await expect(inventoryProductQuery(query,async()=>({data:[{id:'a',product_code:'P-1'}],meta:{total:2,pages:1}}))).rejects.toThrow(/完整/)
})
it('fails when any matching ledger query fails',async()=>{
 await expect(inventoryProductQuery(query,async(path)=>{if(path.startsWith('/inventory-items?'))return {data:[{id:'a',product_code:'P-1'}],meta:{total:1,pages:1}};throw Error('permission denied')})).rejects.toThrow('permission denied')
})
it('queries the union of selected product IDs with server-side position filtering',async()=>{
 const read=vi.fn(async(path:string)=>{
  const u=new URL(path,'https://example.invalid')
  if(u.pathname==='/inventory-items'){const id=u.searchParams.get('product_id');return {data:[{id:`item-${id}`,product_id:id}],meta:{pages:1,total:1}}}
  return {data:[{id:u.searchParams.get('inventory_item_id'),effective_at:'2026-01-01'}],meta:{pages:1,total:1}}
 })
 const result=await inventoryProductQuery({...query,productCode:undefined,productIds:['a','b']},read)
 expect(result.meta.total).toBe(2)
 expect(read.mock.calls.some(([path])=>path.includes('product_id=a'))).toBe(true)
 expect(read.mock.calls.some(([path])=>path.includes('product_id=b'))).toBe(true)
})
