import type { Context } from '@deepseek-ai/cordis'
import { type Domain, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { type CustomPage, customDefinitionSchema } from './custom-model.js'

// A later version may add to a page, its runs or their sources: what this one does not know is carried along.
const run = z.looseObject({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  sessionId: z.string().optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'canceled']),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  error: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  sources: z
    .array(
      z.looseObject({
        collection: z.string(),
        name: z.string().optional(),
        path: z.string().optional(),
        list: z.boolean().optional(),
        total: z.number(),
        firstFetchedAt: z.string().optional(),
        fetchedAt: z.string(),
        ids: z.array(z.string()),
      }),
    )
    .optional(),
  grants: z.string().optional(),
  task: z.string().optional(),
})
const page = z.looseObject({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
  migratedFrom: z.string().optional(),
  sharedFrom: z.looseObject({ author: z.string(), updatedAt: z.string() }).optional(),
  definition: customDefinitionSchema,
  previous: z.looseObject({ version: z.number().int().positive(), definition: customDefinitionSchema }).optional(),
  latest: run.optional(),
  run: run.optional(),
})
const pages = z
  .array(page)
  .max(50)
  .superRefine((items, ctx) => {
    for (const [index, item] of items.entries())
      if (JSON.stringify(item).length > 900_000)
        ctx.addIssue({ code: 'custom', path: [index], message: '单页定义与结果超过 900 KB。' })
    if (JSON.stringify(items).length > 8_000_000) ctx.addIssue({ code: 'custom', message: '个人页面总存储超过 8 MB。' })
  })
/**
 * One person's pages, as the store holds them. The store checks a record whole when it opens, so the record
 * only has to be a list: each page is read on its own. A page this version cannot read, such as one a later
 * version saved in a way this one does not know, is left out of what the person sees and written back as it
 * was, instead of keeping the person from every page they have (docs/53 §11).
 */
export const customPagesDomain = defineDomain({
  name: 'oryh_custom_pages',
  version: 1,
  tables: {
    pages: domainTable<string, unknown[]>(
      z.array(z.unknown()) as unknown as Parameters<typeof domainTable<string, unknown[]>>[0],
    ),
  },
})
export interface CustomPageStorage {
  read(key: string): Promise<CustomPage[]>
  write(key: string, value: CustomPage[]): Promise<void>
}
export class HarnessCustomPageStorage implements CustomPageStorage {
  private domain: Promise<Domain<typeof customPagesDomain>> | undefined
  /** What each stored list came to when read, until it is written again. */
  private readonly parts = new WeakMap<object, { pages: CustomPage[]; kept: unknown[] }>()
  private readonly reported = new Set<string>()
  constructor(private ctx: Context) {
    ctx.effect(
      () => () => {
        void this.domain?.then(
          d => d.close(),
          () => {},
        )
        this.domain = undefined
      },
      'oryh custom pages storage',
    )
  }
  private async table() {
    if (!this.domain) {
      const opening = this.ctx.storageDomain.open(customPagesDomain)
      this.domain = opening
      opening.catch(() => {
        if (this.domain === opening) this.domain = undefined
      })
    }
    return (await this.domain).table('pages')
  }
  /** The pages of a stored list this version reads, and the ones it keeps as they are. */
  private split(stored: unknown[] | undefined): { pages: CustomPage[]; kept: unknown[] } {
    const items = stored ?? []
    const known = this.parts.get(items)
    if (known) return known
    const parts = { pages: [] as CustomPage[], kept: [] as unknown[] }
    for (const item of items) {
      const read = page.safeParse(item)
      if (read.success) {
        parts.pages.push(read.data as CustomPage)
        continue
      }
      parts.kept.push(item)
      const id = String((item as { id?: unknown } | null)?.id ?? '?')
      if (this.reported.has(id)) continue
      this.reported.add(id)
      // Where the page differs, never what it holds.
      const where = [...new Set(read.error.issues.map(issue => issue.path.join('.') || '(page)'))].slice(0, 5)
      this.ctx.logger?.warn?.(`custom page ${id} is kept but not shown: this version cannot read ${where.join(', ')}`)
    }
    this.parts.set(items, parts)
    return parts
  }
  async read(key: string) {
    return structuredClone(this.split((await this.table()).get(key)).pages)
  }
  async write(key: string, value: CustomPage[]) {
    const table = await this.table()
    const { kept } = this.split(table.get(key))
    await table.put(key, [...(pages.parse(value) as CustomPage[]), ...kept])
  }
}
