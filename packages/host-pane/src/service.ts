import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { type ConnectionId, employeeScope, OryhClientError } from '@oryh/ai-client-foundation'
import { canAccessPage, type PageId, pageById, requirePage } from '@oryh/ai-client-pages'
import { type Clock, deploymentTimeZone, readClock } from './clock.js'
import { CommandQueue, type CommandWait } from './commands.js'
import { composed } from './composed.js'
import { NAVIGATION_WITHOUT_PANE, NO_PAGE, UNSAVED_KEEPS_PAGE } from './notices.js'
import { PaneRegistry, type PaneSession } from './registry.js'
import type {
  AnyPaneCommand,
  FormValue,
  PaneAskSubject,
  PaneBindRequest,
  PaneBindView,
  PaneFormContext,
  PaneFrame,
  PaneState,
  PaneSync,
  UserViewSummary,
  WrittenRecord,
} from './types.js'
import type { UserViewRegistry } from './user-views.js'

/**
 * What a question from a page is about, in words the agent can act on: the row's name as the page shows
 * it and, where the page knows them, the collection and id to read it by.
 * @returns the phrase, or an empty string for no subject.
 * @throws when the subject is not one a page could have sent.
 */
function askSubject(subject: PaneAskSubject | undefined): string {
  if (subject === undefined) return ''
  const title = typeof subject.title === 'string' ? subject.title.trim() : ''
  if (!title || title.length > 200) throw fail('提问内容无效。')
  const { resource, id } = subject
  if (resource === undefined && id === undefined) return `关于“${title}”`
  if (
    typeof resource !== 'string' ||
    typeof id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(resource) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)
  )
    throw fail('提问内容无效。')
  return `关于“${title}”，集合 ${resource}，记录编号 ${id}`
}

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

/** How many written records one turn's marker names; a page points out a few, not a batch. */
const WRITTEN_RECORDS = 20

/**
 * A collection's object type as ORYH's console writes it: `sales-orders` is `sales_order`. Every
 * collection a page of this client shows follows the rule, which a test holds them to.
 */
export function objectTypeOf(resource: string): string {
  return resource.replaceAll('-', '_').replace(/s$/, '')
}

/** What a page says went wrong, where it reports one in its content. */
function pageError(session: PaneSession | undefined): string | undefined {
  try {
    const error = (JSON.parse(session?.context?.content ?? 'null') as { error?: unknown } | null)?.error
    return typeof error === 'string' && error ? error : undefined
  } catch {
    return undefined
  }
}

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
  /**
   * The pages of these resources carry out a `record` navigation: given an id they show that record,
   * reading it when their list does not hold it. The pane then opens records for the plugin
   * (`openRecord`), for the agent's tool and for following what it wrote.
   */
  readonly opensRecords?: boolean
  /**
   * The pages of these resources take the conditions a list was read by: a `filters` navigation with
   * values and no fields narrows their list to what it knows of them. Following a read then shows the
   * list as the agent read it, not as the page last had it.
   */
  readonly narrows?: boolean
  /**
   * Show one record because the person asked to see it — they clicked its link in a Chat answer. For a
   * plugin whose pages open a record in a way of their own; one that sets `opensRecords` needs none.
   * Throws, in words for the person, when the record cannot be shown.
   */
  readonly show?: (sessionId: string, resource: string, id: string, signal: AbortSignal) => Promise<void>
  /**
   * What this plugin's own rules make of a form one of its pages describes, beyond each field's kind:
   * given the form and what it would hold once a fill is in, a sentence saying what is wrong — an end
   * date before its start — or nothing. A fill it objects to is refused whole, and the agent told why.
   */
  readonly checkForm?: (
    page: PageId,
    form: PaneFormContext,
    values: Readonly<Record<string, FormValue>>,
  ) => string | undefined
  /**
   * Sessions this plugin starts for work of its own, such as a custom page's data run. Such a session is
   * given exactly `tools` and none of the Chat agent's; the Chat agent is never given `tools`. With
   * `reads` it is also offered ORYH's own tools, and only their reads are let through: a review reads
   * the tenant's definitions as the person could, and writes nothing.
   */
  readonly runner?: { readonly tools: readonly string[]; readonly reads?: boolean; owns(sessionId: string): boolean }
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
  readonly #serverChanges = new Map<string, NonNullable<PaneState['serverChange']>>()
  /** Sessions whose current turn may have written to ORYH since their last marker. */
  readonly #writingTurns = new Map<string, WrittenRecord[]>()
  readonly #serverChangeListeners = new Set<(sessionId: string) => void>()
  readonly #stateProviders: ((sessionId: string) => Partial<PaneState>)[] = []
  readonly #menuProviders: ((connectionId: ConnectionId, scope: string) => Promise<readonly UserViewSummary[]>)[] = []
  readonly #contributions = new Set<PaneContribution>()
  readonly #contributionListeners = new Set<() => void>()
  /** Resolved once: where this deployment keeps time while a session's browser has not said. */
  readonly #deploymentTimeZone = deploymentTimeZone()
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
    // A session the person reopens has no agent until they say something, and the workbench binds as
    // soon as it opens, so a binding cannot wait for one. The branch rule is checked here when there
    // is an agent to check, and again in `home()`, where a business tool always has one.
    this.refuseBranch(request.sessionId)
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
    // the wait that issued it decides whether where the page now is satisfies it. So is one the pane
    // has not answered yet and is still where it was asked from — a command to open another page is
    // issued while the pane is somewhere else, and the pane goes on reporting that page until it moves.
    const acked = new Set((request.acks ?? []).map(ack => ack.id))
    for (const command of this.queue.list(request.sessionId))
      if (
        command.page !== undefined &&
        command.page !== session.page &&
        command.from !== session.page &&
        !acked.has(command.id)
      )
        this.queue.withdraw(request.sessionId, command.lane, command.id)
    // The menu is read from the workspace once per binding; later changes publish themselves.
    if (!this.#menus.has(request.sessionId)) void this.refreshMenu(request.sessionId).catch(() => {})
    this.queue.settle(request.sessionId)
    // A command nobody waits on — one published to follow the conversation — is done once the page has
    // carried it out. Left to expire, it stood in the way of the next one: a second list read within a
    // quarter of a minute of the first was not followed.
    for (const command of this.queue.list(request.sessionId))
      if (acked.has(command.id) && !this.queue.waiting(request.sessionId, command.lane))
        this.queue.withdraw(request.sessionId, command.lane, command.id)
  }

  /** The session's pane, if bound. */
  session(sessionId: string): PaneSession | undefined {
    return this.registry.get(sessionId)
  }

  /** Let a session a plugin started read the pane of the session it works for (see the registry). */
  standIn(sessionId: string, of: string): () => void {
    return this.registry.standIn(sessionId, of)
  }

  /** The session's pane; throws when the session is not bound to an enterprise, or is a branch. */
  home(sessionId: string): PaneSession {
    const session = this.registry.get(sessionId)
    if (!session) throw fail('请先连接企业并打开会话。')
    this.refuseBranch(sessionId)
    return session
  }

  /**
   * Refuse a session that copied another's history: its questions and its page belong to the session
   * it was cut from, not to this one. A session with no agent yet cannot be one, and is left alone.
   *
   * A session the Host started to work for another has a parent too, and is not a copy a person made:
   * it reads its parent's pane because it was set to (`standIn`). Refused here, a review could not use
   * the one tool it was told to read the document with, and went guessing at ORYH's paths instead.
   */
  private refuseBranch(sessionId: string): void {
    if (this.registry.standsIn(sessionId)) return
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent?.session.header.parentSession || agent?.session.header.isSeeded)
      throw new OryhClientError(
        '业务查询请使用新的独立会话，不能绑定复制了其他会话历史的分支。',
        'cross-connection-result',
      )
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
   * What day and time it is for the person this session belongs to: in the zone their browser reported,
   * or the deployment's while none has. A tool that needs "today" asks here, not the Host's own clock.
   * @param sessionId - session asking.
   * @param at - the moment to read; now when omitted.
   */
  clock(sessionId: string, at?: Date): Clock {
    const timeZone = this.registry.get(sessionId)?.timeZone
    return timeZone === undefined
      ? readClock(this.#deploymentTimeZone, 'deployment', at)
      : readClock(timeZone, 'browser', at)
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

  // ── what a page starts ─────────────────────────────────────────────────────────────────────────

  /**
   * The agent of a session, live.
   *
   * A session the person reopened has no agent until they say something in it, and what a page starts —
   * a pre-submit review, a question — used to stop there with "open Chat first". Harness's own session
   * lookup, the one its Remote calls resolve an agent by, brings the agent back as the Chat it is.
   * @throws when the session cannot be brought back.
   */
  async agentOf(sessionId: string): Promise<Agent> {
    const id = SessionId(sessionId)
    const live = this.ctx.agents.get(id)
    if (live) return live
    try {
      const resumed = (await this.ctx.typert?.lookups?.get('agent')?.resolve(id)) as Agent | undefined
      if (resumed) return resumed
    } catch {
      /* said below */
    }
    throw fail('当前会话不可用，请在 Chat 里打开或新建一个会话后重试。')
  }

  /**
   * Wait, briefly, for a session's pane to have reported its page.
   *
   * A session started for what a page is about to do — the person had none — binds first and reports
   * its page a moment later. A question put in that moment reached an agent that saw no page and had to
   * go and ask which record was meant. Nothing is wrong when the wait runs out: the session simply has
   * no pane, and what follows says so in its own way.
   * @param timeoutMs - how long to wait at most.
   */
  async whenPage(sessionId: string, timeoutMs: number = 3000): Promise<void> {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
      // Bound and not yet reported is the only state worth waiting in.
      const session = this.registry.get(sessionId)
      if (session === undefined || session.page !== undefined) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /**
   * Put a question the person asked from a page to the session's agent, as their turn.
   *
   * Where it was asked is the Host's to say, from the page it holds for the session: the agent reads the
   * same page in its context, and the note keeps the turn intelligible later, when the pane has moved on.
   * @param question - what they asked, in the page's words or their own.
   * @param subject - the one row of a list it is about, when it is not about the page as a whole.
   */
  async ask(sessionId: string, question: string, subject?: PaneAskSubject): Promise<void> {
    const text = typeof question === 'string' ? question.trim() : ''
    if (!text || text.length > 500) throw fail('提问内容无效。')
    const about = askSubject(subject)
    this.home(sessionId)
    await this.whenPage(sessionId)
    const session = this.home(sessionId)
    const agent = await this.agentOf(sessionId)
    const page = session.page ? (session.context?.title ?? pageById(session.page)?.title ?? session.page) : undefined
    const where = [page ? `在页面“${page}”上提问` : '', about].filter(Boolean).join('；')
    agent.followup(
      createUserMessage({
        source: composed({ by: 'page-question' }),
        content: [{ type: 'text', text: where ? `${text}\n\n（${where}）` : text }],
      }),
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
    if (this.wouldDisplace(sessionId, spec)) throw fail(UNSAVED_KEEPS_PAGE)
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

  /**
   * Whether a command would take the pane off a page the person has unsaved input on, without their
   * having asked to see another.
   *
   * A page the agent opens to answer a question, or to show what it just wrote, used to replace the form
   * the person was in the middle of; on a wide screen, where both columns show, that is the form vanishing
   * under their hands. What they ask to see (`reveal`) still opens: the page they leave stays mounted
   * with its draft. A command for the page already showing is that page's own to judge.
   */
  wouldDisplace(sessionId: string, spec: Pick<CommandSpec, 'lane' | 'page' | 'payload'>): boolean {
    if (spec.lane !== 'navigation') return false
    if ('reveal' in spec.payload && spec.payload.reveal === true) return false
    const session = this.registry.get(sessionId)
    return session?.context?.unsaved === true && spec.page !== undefined && spec.page !== session.page
  }

  /** Publish a command without waiting on it; the page acts when it can. */
  publish(sessionId: string, spec: CommandSpec): AnyPaneCommand {
    const from = this.registry.get(sessionId)?.page
    const command = {
      lane: spec.lane,
      id: randomUUID(),
      ...(spec.page === undefined ? {} : { page: spec.page }),
      ...(from === undefined ? {} : { from }),
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
  async showPage(sessionId: string, page: PageId | undefined, conditions: Record<string, string> = {}): Promise<void> {
    const session = this.registry.get(sessionId)
    if (!page || !session?.page || this.queue.peek(sessionId, 'navigation')) return
    // The list as the agent read it, where the page can narrow itself that way: a list shown with other
    // conditions than the answer's is a different list from the one being talked about.
    const narrowed = Object.keys(conditions).length > 0 && this.narrows(page)
    // Already there, and nothing to narrow it by.
    if (session.page === page && !narrowed) return
    // Following is a courtesy, and no courtesy to someone whose form it would take away.
    if (session.context?.unsaved === true) return
    const { connection } = await this.verified(sessionId)
    if (this.registry.get(sessionId) !== session || !canAccessPage(connection.identity, page)) return
    this.publish(sessionId, {
      lane: 'navigation',
      page,
      payload: narrowed ? { target: 'filters', page, queryValues: conditions } : { target: 'page', page },
      timeoutMs: 15_000,
    })
  }

  /** Whether a page narrows its list to the conditions a read was made with. */
  narrows(page: PageId): boolean {
    for (const contribution of this.#contributions)
      if (contribution.narrows && Object.values(contribution.resources ?? {}).includes(page)) return true
    return false
  }

  /**
   * Open one record on the page that shows its resource, and wait until the page has it on screen.
   *
   * A list shows a page of what its filters leave; the record the agent means is seldom on it. So the
   * page is told the id and reads the record itself, and says it is open by a context key ending in
   * `:<id>`. Asked without `show` it opens behind Chat on a narrow screen, and not at all over a page
   * the person is typing in.
   * @param resource - the ORYH collection the record is in, e.g. `sales-orders`.
   * @returns whether it opened, and why not when it did not.
   */
  async openRecord(
    sessionId: string,
    resource: string,
    id: string,
    signal: AbortSignal,
    show: boolean = false,
  ): Promise<{ opened: boolean; notice?: string }> {
    // A page of its own, or — for any other collection — the person's menu entry that lists it.
    const entry = this.recordPageOf(resource) === undefined ? this.menuEntryFor(sessionId, resource) : undefined
    const page = this.recordPageOf(resource) ?? (entry ? ('collection' satisfies PageId) : undefined)
    if (page === undefined)
      throw fail(
        `${resource} 没有能按编号打开记录的页面，菜单里也没有它的列表。可以这样打开的集合：${[...this.recordResources(), ...this.menuCollections(sessionId)].join('、') || '（无）'}。`,
      )
    if (typeof id !== 'string' || !id || id.length > 200 || /[/?#\\\s]/.test(id)) throw fail('记录编号无效。')
    const home = this.home(sessionId)
    const shown = home.page !== undefined
    const { connection } = await this.verified(sessionId)
    requirePage(connection.identity, page)
    const payload = {
      target: 'record' as const,
      page,
      recordId: id,
      ...(entry ? { userViewId: entry.id } : {}),
      ...(show ? { reveal: true as const } : {}),
    }
    if (this.wouldDisplace(sessionId, { lane: 'navigation', page, payload }))
      return { opened: false, notice: UNSAVED_KEEPS_PAGE }
    try {
      return await this.issue<{ opened: boolean; notice?: string }>(
        sessionId,
        // With no pane open there is nobody to answer, so that case is not worth a long wait.
        { lane: 'navigation', page, payload, timeoutMs: shown ? 20_000 : 4_000 },
        command => ({
          invalid: () => (this.session(sessionId)?.connectionId !== home.connectionId ? '页面导航已取消。' : undefined),
          until: () => {
            if (!this.acked(sessionId, command)) return undefined
            const now = this.session(sessionId)
            if (now?.page === page && now.context?.key.endsWith(`:${id}`)) return { opened: true }
            return {
              opened: false,
              notice: `页面没有打开这条记录：${pageError(now) ?? '它可能已不存在，或当前账号无权查看。'}`,
            }
          },
          expired: '网页未确认打开这条记录，请重新读取当前页面。',
          signal,
        }),
      )
    } catch (error) {
      if (!shown && this.session(sessionId)?.page === undefined)
        return { opened: false, notice: NAVIGATION_WITHOUT_PANE }
      throw error
    }
  }

  /**
   * Show the record a link in a Chat answer names, because the person clicked it.
   *
   * The link is the record's page in the ORYH console (`/console/objects/<type>/<id>`): good anywhere,
   * and here it opens in the pane beside the conversation instead of in another tab. A record no page of
   * this client shows is not an error — the page then lets the link go to the console.
   * @param name - the record's object type as the console writes it, or its collection.
   * @returns whether the pane showed it, and why not when it did not.
   */
  async showRecord(
    sessionId: string,
    name: string,
    id: string,
    signal: AbortSignal,
  ): Promise<{ opened: boolean; notice?: string }> {
    const resource =
      this.resourceNamed(name) ??
      this.menuCollections(sessionId).find(collection => collection === name || objectTypeOf(collection) === name)
    if (resource === undefined) return { opened: false, notice: '这个客户端没有显示这类记录的页面。' }
    if (this.recordPageOf(resource) !== undefined || this.menuEntryFor(sessionId, resource) !== undefined)
      return this.openRecord(sessionId, resource, id, signal, true)
    const show = [...this.#contributions].find(c => c.resources?.[resource] !== undefined && c.show)?.show
    if (!show) return { opened: false, notice: '这类记录的页面还不能按编号打开。' }
    this.home(sessionId)
    try {
      await show(sessionId, resource, id, signal)
      return { opened: true }
    } catch (error) {
      return { opened: false, notice: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The collection a name means: the collection itself, or its object type as the console writes it. */
  resourceNamed(name: string): string | undefined {
    for (const contribution of this.#contributions)
      for (const resource of Object.keys(contribution.resources ?? {}))
        if (resource === name || objectTypeOf(resource) === name) return resource
    return undefined
  }

  /** The page that opens one record of a resource by id, when the plugin showing it can. */
  recordPageOf(resource: string): PageId | undefined {
    for (const contribution of this.#contributions) {
      const page = contribution.resources?.[resource]
      if (page !== undefined) return contribution.opensRecords ? page : undefined
    }
    return undefined
  }

  /** What the page's plugin objects to in a form as a fill would leave it, if anything. */
  formProblem(page: PageId, form: PaneFormContext, values: Readonly<Record<string, FormValue>>): string | undefined {
    for (const contribution of this.#contributions) {
      const problem = contribution.checkForm?.(page, form, values)
      if (problem) return problem
    }
    return undefined
  }

  /**
   * The menu entry of this session that lists a collection: the person's own or one their role implies.
   * One that shows the whole collection is preferred to one that narrows it — the record meant may be
   * one its filters leave out — though either can show a record of it by id.
   */
  menuEntryFor(sessionId: string, collection: string): UserViewSummary | undefined {
    const entries = this.entries(sessionId).filter(entry => entry.collection === collection)
    return entries.find(entry => Object.keys(entry.filters ?? {}).length === 0) ?? entries[0]
  }

  /** The collections this session's menu lists, beyond those with pages of their own. */
  menuCollections(sessionId: string): string[] {
    const listed = this.entries(sessionId).map(e => e.collection)
    return [...new Set(listed)].filter(collection => this.recordPageOf(collection) === undefined)
  }

  /** Every resource whose records open by id, for telling the agent what it may name. */
  recordResources(): string[] {
    return [...this.#contributions].flatMap(c => (c.opensRecords ? Object.keys(c.resources ?? {}) : []))
  }

  /**
   * The names a record link may carry for the pane to show it: each collection whose records a page
   * opens by id or shows in a way of its own, and its object type as the console writes it. Published
   * with the pane's state, so a click on any other link can go straight to the console (docs/56 §21).
   */
  recordLinkNames(): string[] {
    const names = new Set<string>()
    for (const contribution of this.#contributions)
      if (contribution.opensRecords || contribution.show)
        for (const resource of Object.keys(contribution.resources ?? {}))
          names.add(resource).add(objectTypeOf(resource))
    return [...names].sort()
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

  /**
   * Contribute to the state every frame carries; called on each frame.
   * @returns takes the provider off again. A plugin registers under its own effect, so that one reloaded
   *   by itself does not leave its old provider answering for a service that is gone.
   */
  provideState(provider: (sessionId: string) => Partial<PaneState>): () => void {
    this.#stateProviders.push(provider)
    return () => {
      const index = this.#stateProviders.indexOf(provider)
      if (index >= 0) this.#stateProviders.splice(index, 1)
    }
  }

  /**
   * Contribute to the menu a connection has with no session open; called each time a workbench asks.
   * @param provider - the entries this identity has from its connection alone.
   * @returns takes the provider off again, as `provideState`'s does.
   */
  provideMenu(
    provider: (connectionId: ConnectionId, scope: string) => Promise<readonly UserViewSummary[]>,
  ): () => void {
    this.#menuProviders.push(provider)
    return () => {
      const index = this.#menuProviders.indexOf(provider)
      if (index >= 0) this.#menuProviders.splice(index, 1)
    }
  }

  /**
   * The menu an enterprise identity has before any Chat session is open.
   *
   * Everything else the pane publishes follows a session, but what a person's role implies does not
   * depend on one: a finance clerk who never opens Chat still works invoices. The person's own entries
   * live in a session's workspace and are not here. A contribution that fails leaves the others.
   * @param connectionId - the connection the workbench shows.
   * @returns the entries, in the order their contributors registered.
   */
  async connectionMenu(connectionId: ConnectionId): Promise<UserViewSummary[]> {
    const connection = await this.connections.verifyConnection(connectionId)
    const scope = employeeScope(connection)
    const lists = await Promise.all(
      this.#menuProviders.map(provider => provider(connection.id, scope).catch(() => [] as UserViewSummary[])),
    )
    return lists.flat()
  }

  /** Tell followers the published set changed for reasons other than a command. */
  changed(sessionId: string): void {
    this.queue.changed(sessionId)
  }

  /** Tell every session that has a menu: what changed is not any one session's, such as what colleagues share. */
  changedEverywhere(): void {
    for (const sessionId of this.#menus.keys()) this.queue.changed(sessionId)
  }

  /**
   * Every menu entry this session can open: what the person's role implies, what colleagues shared, and
   * their own.
   */
  entries(sessionId: string): UserViewSummary[] {
    const { roleViews, sharedViews } = this.frame(sessionId).state
    return [...(roleViews ?? []), ...(sharedViews ?? []), ...this.menu(sessionId)]
  }

  /**
   * Remember that this session's current turn may have written to ORYH.
   * @param record - the record the call wrote, where it said which.
   */
  markWrite(sessionId: string, record?: WrittenRecord): void {
    const records = this.#writingTurns.get(sessionId) ?? []
    if (
      record !== undefined &&
      records.length < WRITTEN_RECORDS &&
      !records.some(r => r.collection === record.collection && r.id === record.id)
    )
      records.push(record)
    this.#writingTurns.set(sessionId, records)
  }

  /**
   * A page itself wrote to ORYH, outside any turn — a custom page's form: move the marker now, so the other
   * pages showing what may have changed re-read.
   */
  serverChanged(sessionId: string): void {
    this.#serverChanges.set(sessionId, { id: randomUUID(), at: Date.now() })
    this.queue.changed(sessionId)
    for (const listener of [...this.#serverChangeListeners]) listener(sessionId)
  }

  /** A turn ended: if it may have written, move the marker so pages re-read once. */
  turnEnded(sessionId: string): void {
    const records = this.#writingTurns.get(sessionId)
    if (records === undefined) return
    this.#writingTurns.delete(sessionId)
    this.#serverChanges.set(sessionId, {
      id: randomUUID(),
      at: Date.now(),
      ...(records.length ? { records } : {}),
    })
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
    // Said only once some page shows records: with none mounted yet, the page asks rather than assumes.
    // A collection the person's menu lists opens through its entry, so its links are the pane's too.
    const listed = [...(state.roleViews ?? []), ...(state.sharedViews ?? []), ...(state.userViews ?? [])].map(
      entry => entry.collection,
    )
    const recordLinks = [...new Set([...this.recordLinkNames(), ...listed.flatMap(c => [c, objectTypeOf(c)])])].sort()
    if (recordLinks.length) state.recordLinks = recordLinks
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
