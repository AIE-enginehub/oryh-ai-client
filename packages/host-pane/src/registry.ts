import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ConnectionId, type IdentityScope, OryhClientError } from '@oryh/ai-client-foundation'
import type { PageId } from '@oryh/ai-client-pages'
import type { PaneContext, PaneSync } from './types.js'

/** How many acknowledged command ids a session remembers; a tool waits on one at a time. */
const ACK_MEMORY = 32

/**
 * One session's pane, as last synced. Immutable: a sync produces a new value, so a tool that
 * captured the previous one can tell the pane moved under it by identity alone.
 */
export interface PaneSession {
  readonly connectionId: ConnectionId
  /** The enterprise identity this session is pinned to, for the lifetime of the session. */
  readonly scope: IdentityScope
  /** The pane instance that last synced; a new instance restarts the revision sequence. */
  readonly instance?: string
  readonly revision: number
  /** The page showing, once a pane has synced at all. */
  readonly page?: PageId
  readonly context?: PaneContext
  /** Ids of the commands the page has carried out, newest last. */
  readonly acks: readonly string[]
}

/**
 * Session ⇄ enterprise bindings and the page state each pane last synced.
 *
 * A session binds to one enterprise identity for good: the pin is written to disk under the
 * session's hashed id the first time, and a later Host — or the same one after a restart — refuses
 * to bind that session to anyone else. That is what keeps a conversation's ORYH facts from mixing
 * across tenants (ADR-0003).
 */
export class PaneRegistry {
  readonly #sessions = new Map<string, PaneSession>()
  constructor(private readonly directory: string) {}

  get(sessionId: string): PaneSession | undefined {
    return this.#sessions.get(sessionId)
  }

  /**
   * Bind a session to an enterprise identity, keeping any page state it already synced.
   * @param sessionId - session to bind.
   * @param connectionId - the enterprise connection.
   * @param scope - the connection's identity, as verified now.
   * @returns the session's pane.
   * @throws when the session was pinned to another identity.
   */
  async bind(sessionId: string, connectionId: ConnectionId, scope: IdentityScope): Promise<PaneSession> {
    await this.pin(sessionId, scope)
    const current = this.#sessions.get(sessionId)
    const next: PaneSession =
      current !== undefined && current.connectionId === connectionId && current.scope === scope
        ? current
        : { connectionId, scope, revision: 0, acks: [] }
    this.#sessions.set(sessionId, next)
    return next
  }

  /**
   * Record a page sync.
   * @param sessionId - session whose pane synced.
   * @param sync - the page's state.
   * @returns the new pane, or undefined when the sync was stale and ignored.
   */
  apply(sessionId: string, sync: PaneSync): PaneSession | undefined {
    const current = this.#sessions.get(sessionId)
    if (current === undefined) throw new OryhClientError('会话尚未绑定企业。', 'request-failed')
    if (current.connectionId !== sync.connectionId) throw new OryhClientError('会话尚未绑定企业。', 'request-failed')
    if (!Number.isSafeInteger(sync.revision) || sync.revision < 1)
      throw new OryhClientError('页面版本无效。', 'request-failed')
    if (current.instance === sync.instance && current.revision >= sync.revision) return undefined
    const acks = [...(current.instance === sync.instance ? current.acks : []), ...(sync.acks ?? []).map(a => a.id)]
    const next: PaneSession = {
      connectionId: current.connectionId,
      scope: current.scope,
      instance: sync.instance,
      revision: sync.revision,
      page: sync.page,
      ...(sync.context === undefined ? {} : { context: structuredClone(sync.context) }),
      acks: acks.slice(-ACK_MEMORY),
    }
    this.#sessions.set(sessionId, next)
    return next
  }

  /** Whether the page has carried out this command. */
  acked(sessionId: string, id: string): boolean {
    return this.#sessions.get(sessionId)?.acks.includes(id) ?? false
  }

  /** Forget the session's pane; the pin on disk stays. */
  unbind(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }

  clear(): void {
    this.#sessions.clear()
  }

  /**
   * Pin the session to one identity on disk, or check it against the pin already there.
   *
   * Written once with `wx` and synced through, so two Hosts racing on the same session cannot both
   * win, and a crash between the write and the sync cannot leave a pin that reads as someone else's.
   */
  private async pin(sessionId: string, scope: IdentityScope): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(file, 'wx', 0o600)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    if (handle !== undefined) {
      try {
        await handle.writeFile(JSON.stringify({ scope }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      const directory = await open(this.directory, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    const stored = JSON.parse(await readFile(file, 'utf8')) as { scope: string }
    if (stored.scope !== scope)
      throw new OryhClientError('该会话已绑定其他企业或员工，请创建新会话。', 'cross-connection-result')
  }
}
