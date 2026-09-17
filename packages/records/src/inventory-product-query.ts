import { OryhClientError } from '@oryh/ai-client-foundation'
import type { RecordQuery } from './contracts.js'

type Row = Record<string, unknown> & { id: string }
/**
 * Existing tenant-scoped GETs, fully collected before client-side pagination.
 * @param q - the list query; its products select which inventory items to read.
 * @param read - scoped GET inside the connection.
 * @param filters - declared query parameters, already checked, applied to every movement read so the
 *   server still does the filtering and the total counts only matching rows.
 */
export async function inventoryProductQuery(
  q: RecordQuery,
  read: (path: `/${string}`) => Promise<unknown>,
  filters: readonly [string, string][] = [],
) {
  const extra = filters.map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('')
  let requests = 0
  const limitedRead = async (path: `/${string}`) => {
    if (++requests > 100)
      throw new OryhClientError('产品查询数据量过大，请同时指定库存项编号缩小范围。未返回部分结果。', 'request-failed')
    return read(path)
  }
  async function all(path: `/${string}`): Promise<Row[]> {
    const rows: Row[] = [],
      ids = new Set<string>()
    let total: number | undefined,
      pages = 1
    for (let page = 1; page <= pages; page++) {
      const body = (await limitedRead(`${path}&page=${page}&size=100`)) as {
        data?: Row[]
        meta?: { total: number; pages: number }
      }
      if (
        !Array.isArray(body?.data) ||
        !Number.isSafeInteger(body.meta?.total) ||
        !Number.isSafeInteger(body.meta?.pages) ||
        body.meta!.total < 0 ||
        body.meta!.pages < 0
      )
        throw new Error('产品查询响应无效。')
      if (total !== undefined && total !== body.meta!.total) throw new Error('查询期间记录数量发生变化，请重新查询。')
      total = body.meta!.total
      pages = Math.max(1, body.meta!.pages)
      if (total > 10000 || pages > 100) throw new Error('产品查询数据量过大，请指定库存项编号。未返回部分结果。')
      for (const row of body.data) {
        if (typeof row?.id !== 'string' || ids.has(row.id)) throw new Error('查询期间分页记录发生变化，请重新查询。')
        ids.add(row.id)
        rows.push(row)
      }
    }
    if (rows.length !== total) throw new Error('产品查询未取得完整结果，请重新查询。')
    return rows
  }
  let items: Row[]
  if (q.query.trim()) {
    const body = (await limitedRead(`/inventory-items/${encodeURIComponent(q.query.trim())}`)) as { data?: Row }
    if (body?.data?.id !== q.query.trim()) throw new Error('库存项查询响应无效。')
    items = [body.data]
  } else if (q.productIds?.length) {
    items = []
    for (const id of q.productIds)
      items.push(...(await all(`/inventory-items?status=active&product_id=${encodeURIComponent(id)}`)))
  } else items = await all('/inventory-items?status=active')
  const positions = items.filter(item =>
    q.productIds?.length ? q.productIds.includes(String(item.product_id)) : item.product_code === q.productCode?.trim(),
  )
  const rows: Row[] = []
  for (const item of positions)
    rows.push(...(await all(`/inventory-item-details?inventory_item_id=${encodeURIComponent(item.id)}${extra}`)))
  rows.sort(
    (a, b) =>
      Date.parse(String(b.effective_at)) - Date.parse(String(a.effective_at)) ||
      Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)) ||
      String(b.id).localeCompare(String(a.id)),
  )
  return {
    data: rows.slice((q.page - 1) * 25, q.page * 25),
    meta: { total: rows.length, pages: Math.max(1, Math.ceil(rows.length / 25)) },
  }
}
