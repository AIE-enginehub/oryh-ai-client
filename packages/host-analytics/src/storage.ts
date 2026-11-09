import type { Context } from '@deepseek-ai/cordis'
import { type Domain, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { type AnalysisDocument, definitionSchema } from './model.js'

const schema = z
  .array(
    z.object({
      id: z.string().uuid(),
      version: z.number().int().positive(),
      updatedAt: z.string(),
      definition: definitionSchema,
    }),
  )
  .max(50)
export const analysisDomain = defineDomain({
  name: 'oryh_analyses',
  version: 1,
  tables: {
    documents: domainTable<string, AnalysisDocument[]>(
      schema as unknown as Parameters<typeof domainTable<string, AnalysisDocument[]>>[0],
    ),
  },
})
export interface AnalysisStorage {
  read(key: string): Promise<AnalysisDocument[]>
  write(key: string, documents: AnalysisDocument[]): Promise<void>
}
export class HarnessAnalysisStorage implements AnalysisStorage {
  private domain: Promise<Domain<typeof analysisDomain>> | undefined
  constructor(private ctx: Context) {
    ctx.effect(
      () => () => {
        void this.domain?.then(
          d => d.close(),
          () => {},
        )
        this.domain = undefined
      },
      'oryh analysis storage',
    )
  }
  private async table() {
    if (!this.domain) {
      const opening = this.ctx.storageDomain.open(analysisDomain)
      this.domain = opening
      opening.catch(() => {
        if (this.domain === opening) this.domain = undefined
      })
    }
    return (await this.domain).table('documents')
  }
  async read(key: string) {
    return structuredClone((await this.table()).get(key) ?? [])
  }
  async write(key: string, documents: AnalysisDocument[]) {
    await (await this.table()).put(key, schema.parse(documents))
  }
}
