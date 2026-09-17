import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { type ConnectionId, employeeScope, OryhClientError } from '@oryh/ai-client-foundation'
import { canAccessPage, type PageId, pageById } from '@oryh/ai-client-pages'
import { CommandQueue, type CommandWait } from './commands.js'
import { NO_PAGE } from './notices.js'
import { PaneRegistry, type PaneSession } from './registry.js'
import type {
  AnyPaneCommand,
  PaneBindRequest,
  PaneBindView,
  PaneFrame,
  PaneState,
  PaneSync,
  UserViewSummary,
} from './types.js'
import type { UserViewRegistry } from './user-views.js'

/** What the pane needs to know about connections; the client controller satisfies it. */
export interface PaneConnections {
  verifyConnection(connectionId: ConnectionId): Promise<ConnectionSummary>
  listConnections(): Promise<readonly ConnectionSummary[]>
}

/** A command to issue: its lane, page and payload; the id and expiry are the service's. */
export type CommandSpec = { timeoutMs: number } & (
  | { lane: 'navigation'; page?: PageId; payload: Extract<AnyPaneCommand, { lane: 'navigation' }>['payload'] }
  | { lane: 'form'; page?: PageId; payload: Extract<AnyPaneCommand, { lane: 'form' }>['payload'] }
)

/** The wait a tool attaches to a command it issued; `id` is the command's, for the page's acks. */
export type CommandReceipt<R> = Omit<CommandWait<R>, 'timeoutMs'>

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/**
 * What a page plugin tells the pane about itself, beyond the page registry: the resources it shows,
 * the rules it adds for the agent, the tools it registered, and how to open one of its records.
 */
export interface PaneContribution {
  /** The contributing plugin, for diagnostics. */
  readonly name: string
  /** ORYH resource names (path segments such as `timesheet-headers`) and the page each is shown on. */
  readonly resources?: Readonly<Record<string, PageId>>
  /** Standing rules the agent follows for these pages, appended to the generic ones. */
  readonly prompt?: readonly string[]
  /** Names of the model tools this plugin registered, for the agent's allow-list. */
  readonly tools?: readonly string[]
  /** Open one record of a resource in the pane, e.g. a timesheet the agent just wrote. */
  readonly open?: (sessionId: string, resource: string, id: string) => Promise<void>
}

/**
 * The business pane, as the Host sees it: which enterprise each session works in, what its pane
 * shows, what the agent has asked of it, and the stream that carries those requests to the page.
 *
 * Every page speaks this one protocol. Domain tools read `session()` for what is on screen, issue
 * commands with `issue()` and wait for the page's acknowledgement; the page reports through
 * `sync()`. Nothing here knows what a timesheet or a project is.
 */
export class PaneService {
  readonly queue: CommandQueue = new CommandQueue()
  readonly registry: PaneRegistry
  /** Last menu read per session, so synchronous readers (the stream, page context) can use it. */
  readonly #menus = new Map<string, UserViewSummary[]>()
  /** The last time the agent may have changed ORYH data, per session (ADR-0010). */
  readonly #serverChanges = new Map<string, { id: string; at: number }>()
  /** Sessions whose current turn may have written to ORYH since their last marker. */
  readonly #writingTurns = new Set<string>()
  readonly #serverChangeListeners = new Set<(sessionId: string) => void>()
  readonly #stateProviders: ((sessionId: string) => Partial<PaneState>)[] = []
  readonly #contributions = new Set<PaneContribution>()
  readonly #contributionListeners = new Set<() => void>()
  #serial: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly connections: PaneConnections,
    directory: string,
    readonly userViews: UserViewRegistry,
  ) {
    this.registry = new PaneRegistry(directory)
  }

  // ── binding ────────────────────────────────────────────────────────────────────────────────────

  /** Bind a session to an enterprise. Serialised: two binds for one session cannot interleave. */
  bind(request: PaneBindRequest): Promise<PaneBindView> {
    const result = this.#serial.then(() => this.doBind(request))
    this.#serial = result.catch(() => {})
    return result
  }

  private async doBind(request: PaneBindRequest): Promise<PaneBindView> {
    const agent = this.ctx.agents.get(SessionId(request.sessionId))
    if (!agent) throw fail('请先选择一个已打开的会话。')
    if (agent.session.header.parentSession || agent.session.header.isSeeded)
      throw new OryhClientError(
        '业务查询请使用新的独立会话，不能绑定复制了其他会话历史的分支。',
        'cross-connection-result',
      )
    const connection = (await this.connections.listConnections()).find(c => c.id === request.connectionId)
    if (!connection) throw new OryhClientError('企业连接已失效，请重新连接。', 'connection-not-found')
    const previous = this.registry.get(request.sessionId)
    const session = await this.registry.bind(request.sessionId, request.connectionId, employeeScope(connection))
    if (previous !== undefined && previous !== session) {
      // Another enterprise took the session over: nothing pending for the old one may survive.
      this.queue.clear(request.sessionId, '会话已切换企业。')
      this.#menus.delete(request.sessionId)
    }
    this.queue.settle(request.sessionId)
    return { ready: true, message: 'Chat 已关联当前企业。' }
  }

  /** Withdraw a session's binding: its pane, commands and waits. */
  unbind(sessionId: string): void {
    this.registry.unbind(sessionId)
    this.#menus.delete(sessionId)
    this.queue.clear(sessionId, '会话已离开页面。')
    this.#serial = this.#serial.then(() => {
      this.registry.unbind(sessionId)
      this.queue.clear(sessionId, '会话已离开页面。')
    })
  }

  // ── page state ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Record what the pane shows now.
   *
   * A command waits for the page it belongs to; a sync from any other page withdraws it. Every wait
   * is re-evaluated, since this is the only way page state changes.
   */
  sync(request: PaneSync): void {
    if (pageById(request.page) === undefined) throw fail('页面无效。')
    const session = this.registry.apply(request.sessionId, request)
    if (session === undefined) return
    // A command this very sync acknowledges is kept: the page may have moved on to answer it, and
    // the wait that issued it decides whether where the page now is satisfies it.
    const acked = new Set((request.acks ?? []).map(ack => ack.id))
    for (const command of this.queue.list(request.sessionId))
      if (command.page !== undefined && command.page !== session.page && !acked.has(command.id))
        this.queue.withdraw(request.sessionId, command.lane, command.id)
    // The menu is read from the workspace once per binding; later changes publish themselves.
    if (!this.#menus.has(request.sessionId)) void this.refreshMenu(request.sessionId).catch(() => {})
    this.queue.settle(request.sessionId)
  }

  /** The session's pane, if bound. */
  session(sessionId: string): PaneSession | undefined {
    return this.registry.get(sessionId)
  }

  /** The session's pane; throws when the session is not bound to an enterprise. */
  home(sessionId: string): PaneSession {
    const session = this.registry.get(sessionId)
    if (!session) throw fail('请先连接企业并打开会话。')
    return session
  }

  /** The session's pane with a page showing; throws the no-page notice otherwise. */
  page(sessionId: string): PaneSession & { page: PageId } {
    const session = this.registry.get(sessionId)
    if (!session?.page) throw fail(NO_PAGE)
    return session as PaneSession & { page: PageId }
  }

  /**
   * Whether the pane moved since a tool captured it: a tool that awaited something re-checks
   * before it acts on what it read.
   */
  assertUnchanged(sessionId: string, captured: PaneSession, message: string = '页面已改变，请重新读取。'): void {
    if (this.registry.get(sessionId) !== captured) throw fail(message)
  }

  /** Whether the page has carried out this command. */
  acked(sessionId: string, id: string): boolean {
    return this.registry.acked(sessionId, id)
  }

  /**
   * The session's enterprise connection, verified now, still the identity the session is pinned to.
   * @param sessionId - session asking.
   * @returns the verified connection and the pane as captured before verifying.
   */
  async verified(sessionId: string): Promise<{ connection: ConnectionSummary; session: PaneSession }> {
    const session = this.home(sessionId)
    const connection = await this.connections.verifyConnection(session.connectionId)
    if (employeeScope(connection) !== session.scope)
      throw new OryhClientError('企业身份已改变。', 'connection-identity-mismatch')
    const now = this.registry.get(sessionId)
    if (now === undefined || now.connectionId !== session.connectionId) throw fail('企业页面已改变。')
    return { connection, session: now }
  }

  /**
   * The enterprise a session works in: its own binding, or the only connection this client holds.
   *
   * Skill syncs and ORYH tool calls both go here. Without the business pane a session has no
   * binding, and the agent still has to work on its own; with several connections and no binding
   * there is nothing to choose by, so it says so instead.
   */
  async connectionOf(sessionId: string): Promise<ConnectionId> {
    const session = this.registry.get(sessionId)
    if (session) return session.connectionId
    const connections = await this.connections.listConnections()
    if (connections.length === 1) return connections[0]!.id
    throw fail(
      connections.length
        ? '这个会话没有关联企业，而本机有多个企业连接；请在工作台左侧选择企业后再试。'
        : '本机还没有连接任何企业，请先在工作台连接企业。',
    )
  }

  // ── commands ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Ask the page to do something and wait until it says it has.
   * @param sessionId - session whose pane carries the command out.
   * @param spec - the command.
   * @param receipt - what settles the wait, given the command's id.
   * @returns the receipt `until` produced.
   */
  async issue<R>(sessionId: string, spec: CommandSpec, receipt: (id: string) => CommandReceipt<R>): Promise<R> {
    const command = this.publish(sessionId, spec)
    const wait = receipt(command.id)
    try {
      return await this.queue.wait<R>(sessionId, command.lane, {
        ...wait,
        timeoutMs: spec.timeoutMs,
        // A command withdrawn by a page change fails with the tool's own reason, or else says so; only
        // a newer command on the lane is a supersession.
        invalid: () => {
          const own = wait.invalid?.()
          if (own !== undefined || this.queue.holds(sessionId, command.lane, command.id)) return own
          const moved = command.page !== undefined && this.session(sessionId)?.page !== command.page
          return moved ? '页面已改变，指令已取消。' : '已被新的指令取代。'
        },
      })
    } finally {
      this.queue.withdraw(sessionId, command.lane, command.id)
    }
  }

  /** Publish a command without waiting on it; the page acts when it can. */
  publish(sessionId: string, spec: CommandSpec): AnyPaneCommand {
    const command = {
      lane: spec.lane,
      id: randomUUID(),
      ...(spec.page === undefined ? {} : { page: spec.page }),
      payload: spec.payload,
      expiresAt: Date.now() + spec.timeoutMs,
    } as AnyPaneCommand
    this.queue.issue(sessionId, command)
    return command
  }

  /** Withdraw a lane's command, when the tool that issued it no longer needs it. */
  withdraw(sessionId: string, lane: string, id?: string): void {
    this.queue.withdraw(sessionId, lane, id)
  }

  /**
   * Move the business pane to a page this person may open, when it is showing something else and
   * nothing else is in flight. Best effort and silent (docs/13 §1).
   */
  async showPage(sessionId: string, page: PageId | undefined): Promise<void> {
    const session = this.registry.get(sessionId)
    if (!page || !session?.page || session.page === page || this.queue.peek(sessionId, 'navigation')) return
    const { connection } = await this.verified(sessionId)
    if (this.registry.get(sessionId) !== session || !canAccessPage(connection.identity, page)) return
    this.publish(sessionId, { lane: 'navigation', page, payload: { target: 'page', page }, timeoutMs: 15_000 })
  }

  // ── contributions ──────────────────────────────────────────────────────────────────────────────

  /**
   * Register what a page plugin adds to the pane.
   * @param contribution - the plugin's resources, rules, tools and record opener.
   * @returns withdraws the contribution.
   */
  contribute(contribution: PaneContribution): () => void {
    this.#contributions.add(contribution)
    for (const listener of [...this.#contributionListeners]) listener()
    return () => {
      this.#contributions.delete(contribution)
      for (const listener of [...this.#contributionListeners]) listener()
    }
  }

  /** Every contribution, in registration order. */
  contributions(): readonly PaneContribution[] {
    return [...this.#contributions]
  }

  /** Be told when a contribution is added or withdrawn. */
  onContributionsChange(listener: () => void): () => void {
    this.#contributionListeners.add(listener)
    return () => {
      this.#contributionListeners.delete(listener)
    }
  }

  /** The page a resource is shown on, as some contribution declared it. */
  pageOf(resource: string): PageId | undefined {
    for (const contribution of this.#contributions) {
      const page = contribution.resources?.[resource]
      if (page !== undefined) return page
    }
    return undefined
  }

  // ── published state ────────────────────────────────────────────────────────────────────────────

  /** Contribute to the state every frame carries; called on each frame. */
  provideState(provider: (sessionId: string) => Partial<PaneState>): void {
    this.#stateProviders.push(provider)
  }

  /** Tell followers the published set changed for reasons other than a command. */
  changed(sessionId: string): void {
    this.queue.changed(sessionId)
  }

  /** Remember that this session's current turn may have written to ORYH. */
  markWrite(sessionId: string): void {
    this.#writingTurns.add(sessionId)
  }

  /** A turn ended: if it may have written, move the marker so pages re-read once. */
  turnEnded(sessionId: string): void {
    if (!this.#writingTurns.delete(sessionId)) return
    this.#serverChanges.set(sessionId, { id: randomUUID(), at: Date.now() })
    this.queue.changed(sessionId)
    for (const listener of [...this.#serverChangeListeners]) listener(sessionId)
  }

  /**
   * Hear when ORYH data may have changed under a session — the same moment pages are told to re-read.
   * A domain that caches what it read from ORYH drops it here.
   */
  onServerChange(listener: (sessionId: string) => void): () => void {
    this.#serverChangeListeners.add(listener)
    return () => {
      this.#serverChangeListeners.delete(listener)
    }
  }

  /** Menu entries last read from this session's workspace. */
  menu(sessionId: string): readonly UserViewSummary[] {
    return this.#menus.get(sessionId) ?? []
  }

  /** Publish a menu a tool just wrote, without another read. */
  setMenu(sessionId: string, views: UserViewSummary[]): void {
    this.#menus.set(sessionId, views)
    this.queue.changed(sessionId)
  }

  /**
   * Re-read this session's menu entries from its workspace and publish them to the page.
   * @param sessionId - session whose workspace and enterprise identity select the menu.
   * @returns the entries now published.
   */
  async refreshMenu(sessionId: string): Promise<readonly UserViewSummary[]> {
    const session = this.registry.get(sessionId)
    if (!session) {
      this.#menus.delete(sessionId)
      return []
    }
    const views = await this.userViews.list(sessionId, session.scope)
    if (this.registry.get(sessionId)?.scope !== session.scope) return this.menu(sessionId)
    if (JSON.stringify(views) !== JSON.stringify(this.#menus.get(sessionId))) {
      this.#menus.set(sessionId, views)
      this.queue.changed(sessionId)
    }
    return views
  }

  /** Everything the page needs right now: pending commands and published state. */
  frame(sessionId: string): Pick<PaneFrame, 'commands' | 'state'> {
    const state: PaneState = {}
    const userViews = this.#menus.get(sessionId)
    if (userViews) state.userViews = userViews
    const serverChange = this.#serverChanges.get(sessionId)
    if (serverChange) state.serverChange = serverChange
    for (const provider of this.#stateProviders) Object.assign(state, provider(sessionId))
    return { commands: this.queue.list(sessionId), state }
  }

  /**
   * Follow this session's pane: a baseline, then the full set after every change.
   *
   * A Host restart leaves the browser holding a session it bound to a Host that is gone, and it has
   * no reason to know: its page never reloaded. Opening the stream is that browser saying which
   * session and enterprise it is on, which is what binding needs, so the binding is re-established
   * here under the same checks rather than waiting for a reload.
   */
  async *commands(request: PaneBindRequest, signal: AbortSignal): AsyncIterable<PaneFrame> {
    if (!this.registry.get(request.sessionId)) await this.bind(request).catch(() => {})
    const session = this.registry.get(request.sessionId)
    if (!session || session.connectionId !== request.connectionId) throw fail('会话尚未绑定企业。')
    signal.throwIfAborted()
    let wake: (() => void) | undefined
    // A change arriving while the consumer is still processing the previous frame must not be
    // lost: `wake` is undefined across that window, so the flag records the change and the next
    // iteration emits at once. Changes coalesce rather than queue — every frame carries the whole set.
    let dirty = false
    const off = this.queue.subscribe(request.sessionId, () => {
      dirty = true
      wake?.()
      wake = undefined
    })
    const stop = () => {
      wake?.()
      wake = undefined
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      dirty = false
      yield { type: 'baseline', ...this.frame(request.sessionId) }
      while (!signal.aborted) {
        if (!dirty)
          await new Promise<void>(resolve => {
            wake = resolve
          })
        if (signal.aborted) return
        // Cleared before the frame is read, never after: a change landing while the frame is taken
        // sets the flag again and costs one redundant frame, whereas clearing afterwards would drop it.
        dirty = false
        // The binding is re-read each time: a session that left its page stops receiving commands.
        if (this.registry.get(request.sessionId)?.connectionId !== request.connectionId) return
        yield { type: 'update', ...this.frame(request.sessionId) }
      }
    } finally {
      off()
      signal.removeEventListener('abort', stop)
    }
  }

  /** Release everything on plugin unload. */
  dispose(): void {
    this.registry.clear()
    this.#menus.clear()
    this.#serverChanges.clear()
    this.#writingTurns.clear()
    this.queue.disposeAll()
  }
}
