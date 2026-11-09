import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { type Domain, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { z } from 'zod'
import type { UserViewSummary } from './types.js'

/**
 * Menu entries a person made through Chat, kept in the Harness workspace their session belongs to.
 *
 * Stored through `ctx.storageDomain` — the same durable KV form the workspace registry itself uses —
 * so the data lives under DSH_HOME beside that registry, never as a file in the workspace DIRECTORY,
 * which for a desktop user is their own project. Entries are keyed by workspace AND enterprise
 * identity: one workspace used against two companies keeps two menus, since an entry narrows a
 * company's list.
 *
 * The Host owns the list. The page only renders what the command stream publishes, which is why an
 * add needs no acknowledgement from a page that may not even be open.
 */

/** How many entries one person may keep in one workspace, so a runaway agent cannot bury the menu. */
export const USER_VIEW_LIMIT = 30

/** How many columns one entry may name, so a runaway agent cannot store a table nobody can read. */
const COLUMN_LIMIT = 60

/** A collection as ORYH's own catalogue spells it, which is also the last segment of its list path. */
const COLLECTION = /^[a-z][a-z0-9-]{0,63}$/
/** A field of a row, as the deployment's schema spells it. */
const FIELD = /^[a-z_][a-z0-9_]{0,63}$/

const column = z.object({ field: z.string().regex(FIELD), label: z.string().trim().min(1).max(24) })

const view = z
  .object({
    id: z.string().regex(/^[0-9a-f-]{36}$/),
    label: z.string().trim().min(1).max(24),
    // Entries written before a menu could name any collection carry `kind`, which held the same word:
    // the four built-in lists are addressed by their collection name too. Read as one, stored as the other.
    kind: z.string().optional(),
    collection: z.string().regex(COLLECTION).optional(),
    filters: z.record(z.string().regex(FIELD), z.string().min(1).max(200)),
    display: z
      .object({
        title: z.string().regex(FIELD).optional(),
        summary: z.string().regex(FIELD).optional(),
        date: z.string().regex(FIELD).optional(),
        columns: z.array(column).max(COLUMN_LIMIT),
      })
      .optional(),
  })
  .transform(({ kind, collection, display, ...rest }, ctx): UserViewSummary => {
    const named = collection ?? kind
    if (named === undefined || !COLLECTION.test(named)) {
      ctx.addIssue({ code: 'custom', message: 'a menu entry must name the collection it shows' })
      return z.NEVER
    }
    return { ...rest, collection: named, ...(display === undefined ? {} : { display: shown(display) }) }
  })

/** How a menu entry is made, apart from what its owner calls it: what sharing one hands to colleagues. */
export type UserViewMake = Pick<UserViewSummary, 'collection' | 'filters' | 'display'>

/**
 * Read how a shared menu entry is made. It was written by a colleague's Host and kept by the
 * deployment, so it is checked as anything this Host did not write.
 * @param body - the shared definition.
 * @returns how to make it, or undefined when this version cannot read it.
 */
export function readSharedView(body: unknown): UserViewMake | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const read = view.safeParse({ ...body, id: '00000000-0000-0000-0000-000000000000', label: 'x' })
  if (!read.success) return undefined
  const { collection, filters, display } = read.data
  return { collection, filters, ...(display === undefined ? {} : { display }) }
}

/** Drop the keys nobody set, so an absent field stays absent rather than becoming an undefined one. */
function shown(display: {
  title?: string | undefined
  summary?: string | undefined
  date?: string | undefined
  columns: { field: string; label: string }[]
}): NonNullable<UserViewSummary['display']> {
  return {
    columns: display.columns,
    ...(display.title === undefined ? {} : { title: display.title }),
    ...(display.summary === undefined ? {} : { summary: display.summary }),
    ...(display.date === undefined ? {} : { date: display.date }),
  }
}
const entry = z.object({ views: z.array(view).max(USER_VIEW_LIMIT), updatedAt: z.string() })
type Entry = z.infer<typeof entry>

/** Durable declaration; the name must satisfy the storage unit rule `^[a-z][a-z0-9_]*$`. */
export const userViewsDomain = defineDomain({
  name: 'oryh_user_views',
  version: 1,
  // The Host's zod and the linked Harness's zod are separate copies, so their `ZodType` internals do
  // not unify at compile time even at the same version. The storage domain only calls `.parse`, which
  // this schema has; the cast bridges the two type identities and changes nothing at runtime.
  tables: { views: domainTable<string, Entry>(entry as unknown as Parameters<typeof domainTable<string, Entry>>[0]) },
})

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/** What a registry needs from a session: its working directory, which is what names its workspace. */
interface SessionAgent {
  session: { header: { cwd?: string } }
}

export class UserViewRegistry {
  private domain: Promise<Domain<typeof userViewsDomain>> | undefined
  /** Session to workspace, resolved once: a session's cwd never changes. */
  private workspaces = new Map<string, string>()
  constructor(private ctx: Context) {}

  /** Register the close with the plugin's lifetime. Called during setup: effects belong there, not at first use. */
  install(): void {
    this.ctx.effect(
      () => () => {
        void this.domain?.then(
          d => d.close(),
          () => {},
        )
        this.domain = undefined
        this.workspaces.clear()
      },
      'oryh user views domain',
    )
  }

  /** Open the domain on first use. A failed open is not cached, so the next call retries. */
  private async table() {
    if (!this.domain) {
      const storage = this.ctx.get('storageDomain')
      if (!storage) throw fail('当前运行环境没有 Harness 存储，无法保存菜单项。')
      const opening = storage.open(userViewsDomain)
      this.domain = opening
      opening.catch(() => {
        if (this.domain === opening) this.domain = undefined
      })
    }
    return (await this.domain).table('views')
  }

  /**
   * The Harness workspace a session belongs to: the one whose path is the session's working directory.
   * @param sessionId - Chat session.
   * @returns the workspace id.
   */
  async workspace(sessionId: string): Promise<string> {
    const cached = this.workspaces.get(sessionId)
    if (cached) return cached
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) throw fail('当前运行环境没有 Harness workspace，无法保存菜单项。')
    // A restored browser can bind before its Agent is resumed. The public workspace registry
    // still owns that session's membership, so menu/page reads must not depend on a live Agent.
    const membership = registry.list().find(workspace => workspace.sessionIds.includes(SessionId(sessionId)))
    if (membership) {
      this.workspaces.set(sessionId, membership.id)
      return membership.id
    }
    const agent: SessionAgent | undefined = this.ctx.agents.get(SessionId(sessionId))
    const cwd = agent?.session.header.cwd
    if (!cwd) throw fail('当前会话不可用，无法确定所在的 workspace。')
    const workspace = await registry.resolveByPath(cwd)
    if (!workspace) throw fail('当前会话不属于任何 workspace，无法保存菜单项。')
    this.workspaces.set(sessionId, workspace.id)
    return workspace.id
  }

  /** Storage key: one menu per workspace per enterprise identity. */
  private async key(sessionId: string, identity: string) {
    return `${await this.workspace(sessionId)} ${identity}`
  }

  /**
   * Entries in the session's workspace for this enterprise identity.
   * @param sessionId - Chat session, which selects the workspace.
   * @param identity - enterprise identity scope, as the chat binding records it.
   * @returns the entries in the order they were added.
   */
  async list(sessionId: string, identity: string): Promise<UserViewSummary[]> {
    return [...((await this.table()).get(await this.key(sessionId, identity))?.views ?? [])]
  }

  /**
   * Add one entry durably.
   * @param sessionId - Chat session, which selects the workspace.
   * @param identity - enterprise identity scope.
   * @param added - the entry; its label must be unique in this menu.
   * @returns the full list after the write.
   */
  async add(sessionId: string, identity: string, added: UserViewSummary): Promise<UserViewSummary[]> {
    const table = await this.table(),
      key = await this.key(sessionId, identity)
    const views = table.get(key)?.views ?? []
    if (views.some(v => v.label === added.label)) throw fail(`已经有名为“${added.label}”的菜单项。`)
    if (views.length >= USER_VIEW_LIMIT) throw fail(`菜单项已达 ${USER_VIEW_LIMIT} 个上限，请先删除不用的。`)
    const next = { views: [...views, added], updatedAt: new Date().toISOString() }
    // Parse before writing, so a bad entry is refused here rather than poisoning the stored record.
    await table.put(key, entry.parse(next))
    return next.views
  }

  /**
   * Remove one entry durably.
   * @param sessionId - Chat session, which selects the workspace.
   * @param identity - enterprise identity scope.
   * @param id - entry to remove.
   * @returns the removed entry, or undefined when there was none.
   */
  async remove(sessionId: string, identity: string, id: string): Promise<UserViewSummary | undefined> {
    const table = await this.table(),
      key = await this.key(sessionId, identity)
    const views = table.get(key)?.views ?? []
    const removed = views.find(v => v.id === id)
    if (!removed) return undefined
    const rest = views.filter(v => v.id !== id)
    if (rest.length) await table.put(key, { views: rest, updatedAt: new Date().toISOString() })
    else await table.delete(key)
    return removed
  }

  /** Rename a personal entry without changing its stable route or widening its collection. */
  async rename(sessionId: string, identity: string, id: string, label: string): Promise<void> {
    const table = await this.table(),
      key = await this.key(sessionId, identity)
    const views = table.get(key)?.views ?? []
    const old = views.find(v => v.id === id && v.origin !== 'role')
    if (!old) throw fail('菜单项不存在。')
    if (views.some(v => v.id !== id && v.label === label)) throw fail(`已经有名为“${label}”的菜单项。`)
    await table.put(
      key,
      entry.parse({ views: views.map(v => (v.id === id ? { ...v, label } : v)), updatedAt: new Date().toISOString() }),
    )
  }

  /** Forget a session's workspace, e.g. when the plugin restarts. */
  forget(sessionId: string) {
    this.workspaces.delete(sessionId)
  }
}
