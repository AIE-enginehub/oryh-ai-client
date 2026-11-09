import type { ConnectionId } from './brand.js'
import { OryhClientError } from './errors.js'
import type { OryhHttpClient } from './http.js'

/** A query parameter's value, as ORYH's list and detail operations take them. */
export type PageReadQuery = Readonly<Record<string, string | number | boolean>>

/**
 * ORYH paths no page reads: signing in and the keys that stand for a person. What a page shows is
 * business data; a key's listing is how the enterprise is run, not something to display or summarize.
 */
const RESERVED = /^\/(oauth|api-keys|platform)(\/|$)/

/**
 * Reads ORYH for a custom page's data run (docs/48 §17): GET only, as the person the page belongs to.
 * The run's agent names a path; that this can only read is enforced here, not asked of the model.
 */
export class PageReader {
  constructor(
    private readonly http: OryhHttpClient,
    private readonly verify: (id: ConnectionId) => Promise<unknown>,
  ) {}

  /**
   * @param connectionId - the enterprise the page belongs to.
   * @param path - an ORYH path under `/api/v1`, with its own parameters filled in and no query string.
   * @param query - the query parameters, sent encoded.
   * @returns ORYH's answer body.
   */
  async read(connectionId: ConnectionId, path: string, query: PageReadQuery = {}): Promise<unknown> {
    if (!/^\/[A-Za-z0-9_\-./]{1,300}$/.test(path) || path.includes('..') || path.includes('//'))
      throw new OryhClientError('读取路径无效：只能是 /api/v1 之后的路径，不带查询串。', 'request-failed')
    if (RESERVED.test(path)) throw new OryhClientError(`页面不能读取 ${path}。`, 'request-failed')
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.[\]]{0,63}$/.test(name))
        throw new OryhClientError(`查询参数名 ${name} 无效。`, 'request-failed')
      search.set(name, String(value))
    }
    await this.verify(connectionId)
    const suffix = search.size ? `?${search}` : ''
    return this.http.request(connectionId, { method: 'GET', path: `${path}${suffix}` as `/${string}` })
  }
}
