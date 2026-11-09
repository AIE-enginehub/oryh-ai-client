import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  AttachmentUploader,
  OryhClientController,
  OryhClientHost,
  OryhMcpClient,
  OryhSkillService,
} from '@oryh/ai-client-core'
import { OryhClientError, parseEmployeeScope } from '@oryh/ai-client-foundation'
import type { ChatCapabilities } from '@oryh/dsh-connection'
import { currentPage, NO_PAGE_CONTEXT, type PaneService, textOutput, UNSAVED_KEEPS_PAGE } from '@oryh/dsh-pane'
import { type ChatFiles, UPLOAD_TOOL, uploadTool } from './attachments.js'
import { answerShape, conditionsOf, mentions, recordIdOf, resourceOf, writtenRecord } from './follow.js'
import { OryhMcpTools } from './mcp-tools.js'
import { jsonPromptText, plainPromptText } from './prompt-text.js'
import { addressText, clockText, instructions, UPLOAD_RULE } from './prompts.js'
import { READ_RULE, READ_TOOL, readTool } from './read-attachment.js'
import { RuleWatch } from './rule-watch.js'
import { SKILL_FILE_RULE, SKILL_FILE_TOOL, skillFileTool } from './skill-file.js'

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/** What the agent is built from. */
export interface BusinessAgentOptions {
  readonly controller: Pick<OryhClientController, 'listConnections'>
  /** Verifications are forgotten when a turn starts, so one turn asks ORYH once. */
  readonly host?: Pick<OryhClientHost, 'forgetVerifications'>
  readonly pane: PaneService
  readonly skills?: OryhSkillService
  readonly mcp?: OryhMcpClient
  readonly capabilities: ChatCapabilities
  /** Files the person attaches in Chat, and how one is filed with ORYH; without them none is offered. */
  readonly attachments?: {
    readonly files: ChatFiles
    readonly uploader: Pick<AttachmentUploader, 'upload'>
  }
}

// 'skill' and 'bash' are what make the Chat pane a generic ORYH agent (ADR-0009): ORYH's business
// logic arrives as skills, and the shell is for the local work a request may need. What still bounds
// the agent is the API's own require_permission and a catalog that only carries the holder's skills.
// 'ask_user_question' is Harness's own way to put a decision to the person as buttons in Chat: a write
// to confirm, one of several candidates to pick. It was installed and never offered, so every such
// question was prose the person answered by typing (docs/56 §13).
// 'oryh_skill_file' reads what a skill ships beside its instructions, where there may be no shell to.
const BASE_TOOLS: readonly string[] = ['skill', 'bash', 'oryh_skill_sync', SKILL_FILE_TOOL, 'ask_user_question']
// What reads and stops the background work a shell step starts. Harness's shell tool keeps a command that
// outlives its timeout running as a job, and takes `run_in_background`; it then tells the agent to read
// the job with `job_output` and stop it with `job_kill`. Left out of this list, those were refused: the
// agent learned of the result only when the command ended by itself, and could not stop one it had
// started wrongly. They go with the shell and reach nothing but the session's own jobs.
const JOB_TOOLS: readonly string[] = ['job_output', 'job_list', 'job_kill']

/**
 * The ORYH business agent: the Chat session as a complete ORYH client (ADR-0010), with the business
 * pane beside it as an aid.
 *
 * It installs the standing rules, the per-agent tool policy, ORYH's own MCP tools and the pane's
 * following of what the agent reads and writes. What the pages add — their tools, rules and record
 * openers — reaches it through the pane's contributions, so nothing here names a domain.
 */
export class BusinessAgent {
  /** ORYH's MCP tools, listed from the server and offered to the agent (ADR-0012). */
  readonly mcpTools: OryhMcpTools
  private readonly pane: PaneService
  /** Whether the rules a conversation read are still the tenant's rules. */
  private readonly rules: RuleWatch

  constructor(
    private readonly ctx: Context,
    private readonly options: BusinessAgentOptions,
  ) {
    this.pane = options.pane
    this.mcpTools = new OryhMcpTools(
      ctx,
      options.mcp,
      id => this.pane.connectionOf(id),
      () => this.ownTools(),
      (id, args, text) => {
        this.pane.markWrite(id, writtenRecord(args, text))
        void this.followWrite(id, args, text)
      },
      (id, args, text, tool) => {
        // A plugin's own run reads for itself and is over in a moment; only a conversation outlives a rule.
        if (!this.runnerOf(id)) this.rules.read(id, tool, args, text)
        void this.followRead(id, args, text)
      },
    )
    this.rules = new RuleWatch(async (id, tool, args, signal) => {
      if (!options.mcp) throw new Error('there is no ORYH to ask')
      const result = await options.mcp.callTool(await this.pane.connectionOf(id), tool, args as never, {
        signal,
      })
      if (result.isError) throw new Error('the rules could not be read again')
      return result.text
    })
  }

  /** Ask the active delivery service to compare its trusted principal with the session binding. */
  skillIdentity(sessionId: string): string {
    if (!this.options.skills) return '本次运行没有装载 ORYH 技能服务。'
    const session = this.pane.session(sessionId)
    if (!session) return this.options.skills.identityContext()
    return this.options.skills.identityContext({ ...parseEmployeeScope(session.scope), tenantName: '', email: '' })
  }

  /** The client's own tools: the base ones this deployment offers, plus what every page contributed. */
  private ownTools(): string[] {
    const base = this.options.capabilities.shell
      ? [...BASE_TOOLS, ...JOB_TOOLS]
      : BASE_TOOLS.filter(name => name !== 'bash')
    // Taking the name also keeps ORYH's own upload_attachment, which wants the bytes from the model, away.
    const upload = this.uploads() ? [UPLOAD_TOOL] : []
    // Reading what the person attached needs no write: it is offered wherever attachments are kept.
    const read = this.options.attachments ? [READ_TOOL] : []
    return [...base, ...read, ...upload, ...this.pane.contributions().flatMap(contribution => contribution.tools ?? [])]
  }

  /** Whether files attached in Chat can be filed with ORYH here: a read-only server writes nothing. */
  private uploads(): boolean {
    return this.options.attachments !== undefined && this.options.capabilities.writes
  }

  private allowedTools(): string[] {
    return [...this.ownTools(), ...this.mcpTools.names]
  }

  /**
   * What one session may call: a page plugin's own run is given its tools and nothing of the Chat agent's
   * (no shell, no ORYH writes); every other session gets the Chat agent's list, which never has them.
   */
  private allowedFor(sessionId: string): readonly string[] {
    const runner = this.runnerOf(sessionId)
    if (!runner) return this.allowedTools()
    // A run that reads ORYH for itself is offered the server's tools; `mayCall` lets only its reads through.
    return runner.reads ? [...runner.tools, ...this.mcpTools.names] : runner.tools
  }

  /** The plugin run a session is, when it is one: a custom page's data run, a pre-submit review. */
  private runnerOf(sessionId: string) {
    return this.pane.contributions().find(contribution => contribution.runner?.owns(sessionId))?.runner
  }

  /**
   * Why a session may not make a call, if it may not: a tool outside what it was given, or — for a
   * plugin's run that only reads — one of ORYH's tools in a call that would write.
   */
  private refusal(sessionId: string, name: string, args: unknown): string | undefined {
    if (!this.allowedFor(sessionId).includes(name))
      return '这个工具不在 ORYH 客户端为本会话开放的工具中。业务操作请按对应的 ORYH skill 执行。'
    if (this.runnerOf(sessionId)?.reads && this.mcpTools.reads(name, args) === false)
      return '这个会话只能读取 ORYH，不能写入。'
    return undefined
  }

  /** The standing rules, with what the pages added. */
  instructions(): string {
    return instructions(this.options.capabilities, [
      SKILL_FILE_RULE,
      ...(this.options.attachments ? [READ_RULE] : []),
      ...(this.uploads() ? [UPLOAD_RULE] : []),
      ...this.pane.contributions().flatMap(contribution => contribution.prompt ?? []),
    ])
  }

  private known(resource: string): boolean {
    return this.pane.pageOf(resource) !== undefined
  }

  /**
   * Whether a call is about the document the page on screen is about.
   *
   * Approving an employee's timesheet from the todo that asked for it once moved the pane to "我的工时":
   * the timesheet belongs to that page, so the pane followed the write there — away from the todo the
   * person was working, onto a list of their own timesheets it was not in. A call that names the page's
   * subject leaves the page where it is; the page re-reads on the write and shows what came of it.
   */
  private aboutSubject(sessionId: string, args: unknown): boolean {
    const subject = this.pane.session(sessionId)?.context?.subject
    return subject !== undefined && mentions(args, subject.id)
  }

  /**
   * Show in the business pane what the agent just read (docs/13 §1: the middle pane is what this is now).
   *
   * Telling the agent to open the page does not survive contact with a skill that only describes how to
   * read the data — it answers in chat and the pane stays where it was. So the pane follows the call
   * itself. Best effort and silent: no pane, no permission, or a navigation already in flight all mean
   * nothing happens here.
   *
   * It follows a person who is browsing, and leaves alone one who has something open. A list shown is a
   * place to move on from; a document, a form or a custom page is what the person is looking at, and
   * reading something else to answer them is no reason to take it away: asked from an order what state
   * it was in, the agent read the todo list on the way and the order was gone from the pane (docs/56 §8).
   * What the agent names still reaches them: its answer carries the records' links.
   */
  private async followRead(sessionId: string, args: unknown, text: string): Promise<void> {
    try {
      // What a plugin's own run reads is its working, not the conversation: the pane stays where it is.
      if (this.runnerOf(sessionId)) return
      if (this.aboutSubject(sessionId, args)) return
      const here = this.pane.session(sessionId)
      // A page that has said what it shows, and it is not a list: something is open.
      if (here?.context !== undefined && !here.context.key.endsWith(':list')) return
      const resource = resourceOf(args, r => this.known(r))
      const shape = answerShape(text)
      const page = resource ? this.pane.pageOf(resource) : undefined
      // One record — read by its path, or the single row a lookup by number came back with — is the
      // document the agent is about to talk about, and opens beside the answer. Not from its own list:
      // someone looking at that list asked for the list.
      const id = resource ? (shape.list ? shape.only : recordIdOf(args, resource, true)) : undefined
      if (
        resource &&
        id &&
        here?.page !== undefined &&
        here.page !== page &&
        (await this.openRecord(sessionId, resource, id, false))
      )
        return
      // A list: the page that shows it, narrowed as the agent read it where the page can do that.
      if (shape.list) await this.pane.showPage(sessionId, page, conditionsOf(args))
    } catch {
      /* following the conversation is best effort; a failure must not disturb the call */
    }
  }

  /**
   * Open one record the agent read or wrote, behind Chat.
   *
   * What it wrote goes through the page plugin's own opener where it has one: a timesheet may hold the
   * draft the agent filled, which gives way to what was just saved. What it only read never does — a
   * read is no reason to drop a draft — and opens through the pane or not at all.
   * @param wrote - the record was just written, not merely read.
   * @returns whether the pane was asked to show it; false when no page opens records of this resource.
   */
  private async openRecord(sessionId: string, resource: string, id: string, wrote: boolean): Promise<boolean> {
    const opener = this.pane.contributions().find(c => c.resources?.[resource] !== undefined && c.open)
    if (wrote && opener?.open) {
      await opener.open(sessionId, resource, id)
      return true
    }
    if (this.pane.recordPageOf(resource) === undefined) return false
    const result = await this.pane.openRecord(sessionId, resource, id, AbortSignal.timeout(20_000))
    // Kept off a page the person is typing in: that is an answer, and the list must not go there either.
    return result.opened || result.notice === UNSAVED_KEEPS_PAGE
  }

  /**
   * Open what the agent just wrote (docs/36: the pane follows the conversation, not the model's goodwill).
   *
   * A write the person asked for in Chat ends with a record they are being told about; leaving the pane
   * on whatever it showed before is how a submitted timesheet stayed on an unsaved draft. A page that
   * can open one record by id does so; anything else moves to its list.
   */
  private async followWrite(sessionId: string, args: unknown, text: string): Promise<void> {
    try {
      if (this.runnerOf(sessionId)) return
      if (this.aboutSubject(sessionId, args)) return
      const resource = resourceOf(args, r => this.known(r))
      if (!resource) return
      const id = answerShape(text).id ?? recordIdOf(args, resource)
      if (
        id &&
        this.pane.session(sessionId)?.page !== undefined &&
        (await this.openRecord(sessionId, resource, id, true))
      )
        return
      await this.pane.showPage(sessionId, this.pane.pageOf(resource))
    } catch {
      /* following the conversation is best effort */
    }
  }

  install(): void {
    const { ctx } = this
    // Delivery owns refresh semantics: desktop reinstalls its bundle, MCP invalidates its catalog.
    ctx.tools.register(
      defineTool({
        name: 'oryh_skill_sync',
        description: this.options.skills?.syncDescription ?? '刷新本会话已授权的 ORYH 技能。',
        parameters: {},
        output: textOutput,
        execute: async (_args, exec) => {
          if (!exec.agent) throw new Error('需要会话')
          if (!this.options.skills) throw fail('本次运行没有装载技能服务。')
          const connectionId = await this.pane.connectionOf(String(exec.agent.id))
          exec.signal.throwIfAborted()
          return JSON.stringify(await this.options.skills.sync(connectionId, true))
        },
      }),
    )
    ctx.tools.register(skillFileTool(ctx))
    const attachments = this.options.attachments
    if (attachments) ctx.tools.register(readTool({ files: attachments.files }))
    if (attachments && this.uploads())
      ctx.tools.register(
        uploadTool({
          files: attachments.files,
          uploader: attachments.uploader,
          connectionOf: id => this.pane.connectionOf(id),
        }),
      )
    // Deliberately NOT `complete: true`. That flag restores this section as the *sole* prompt
    // section, which also drops the skill catalog — leaving the agent holding the `skill` tool with
    // no idea which skills exist. Under ADR-0009 the Chat pane is a generic ORYH agent, so the
    // catalog has to survive and this section steers rather than replaces.
    // The standing rules plus whatever the pages contributed: prose, not a template. A rule that mentions
    // `{{` is text, and reading it as a variable reference would fail the assembly.
    ctx.systemPrompt.section({
      name: 'oryh-business-assistant',
      order: 10000,
      // Evaluated at each assembly, as the tool policy is re-applied at each change: a page plugin that
      // registers or goes after this plugin started must not leave the agent allowed a tool its rules
      // never mention, or told of one that is gone.
      text: () => this.instructions(),
      interpolate: false,
    })
    // What each agent had put on, taken off when that agent is disposed and not only when this plugin
    // goes: a custom page's refresh makes an agent and disposes it every time, and each one left its
    // listeners here — holding the agent, and re-applying its tool policy on every later change.
    const mounted = new Map<Agent, Array<() => unknown>>()
    const mount = (agent: Agent) => {
      if (mounted.has(agent)) return
      const held: Array<() => unknown> = []
      mounted.set(agent, held)
      // Each on its own: one that cannot be put on is said and the rest still are. They used to stand or
      // fall together, and a tool name nothing had registered left the agent with no policy, no clock and
      // no page for the rest of its life.
      const own = (effect: Parameters<typeof ctx.effect>[0], label: string) => {
        try {
          held.push(ctx.effect(effect, label))
        } catch (error) {
          ctx.logger?.warn?.(
            `ORYH could not put ${label} on a session: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      // Harness refuses a restriction that names a tool it does not have, whole. A name with nothing
      // behind it — a page plugin's tool that never registered, `bash` where the preset has no shell — is
      // left out and said, so that everything else the agent may not use is still hidden from it.
      //
      // "Has" is asked both ways. A preset's own tools — `ask_user_question`, the buttons a write is
      // confirmed with — are put on for the sessions of that preset and are in nobody's global list: asked
      // only globally, they were taken for missing, left out, and the agent could no longer ask with
      // buttons. Asked only as this agent sees them, a tool that registers later would never be found,
      // since the restriction already on hides it from the agent.
      const allowed = () => {
        const wanted = [...this.allowedFor(id)]
        const known = wanted.filter(
          name => ctx.tools.get(name) !== undefined || ctx.tools.get(name, agent) !== undefined,
        )
        if (known.length < wanted.length)
          ctx.logger?.warn?.(
            `ORYH tool policy: left out, not registered: ${wanted.filter(name => !known.includes(name)).join(', ')}`,
          )
        return known
      }
      // The allow-list grows when a page plugin or ORYH's MCP tools register, so the restriction is
      // re-applied: the new one goes on before the old comes off, and the agent never sees more than
      // either allows.
      const id = String(agent.id)
      own(() => {
        let lift = agent.ctx.tools.restrict({ allow: allowed() })
        const reapply = () => {
          const next = agent.ctx.tools.restrict({ allow: allowed() })
          lift()
          lift = next
        }
        const offMcp = this.mcpTools.onChange(reapply)
        const offPages = this.pane.onContributionsChange(reapply)
        return () => {
          offMcp()
          offPages()
          lift()
        }
      }, 'oryh tool policy')
      own(() => agent.ctx.tools.presentAs('native'), 'oryh native business tools')
      // A desktop container starts before its owner signs in, so the listing at startup found no
      // connection and ORYH's tools never arrived. Each session asks again for its own enterprise; a
      // connection already listed is not asked twice, and the policy above widens when the tools land.
      void Promise.resolve()
        .then(() => this.pane.connectionOf(id))
        .then(connection => this.mcpTools.refresh(connection))
        .catch(() => {})
      // A plugin's own run has its own instructions; the Chat's page and skill context are not its business.
      if (this.runnerOf(id)) return
      own(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'oryh-skill-identity',
            order: 10001,
            text: () => plainPromptText(this.skillIdentity(String(agent.id))),
          }),
        'oryh skill identity',
      )
      // Before the page: the date moves once a day, the page with every click, and what stands first
      // in the prompt is what the model can go on reusing.
      own(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'oryh-clock',
            order: 9999,
            text: () => clockText(this.pane.clock(String(agent.id))),
          }),
        'oryh clock',
      )
      // Where this session's ORYH is: what a record's link is written against. A session bound to no
      // enterprise yet has none, and the agent writes no links.
      own(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'oryh-address',
            order: 9998,
            text: () => {
              const scope = this.pane.session(String(agent.id))?.scope
              try {
                return scope ? plainPromptText(addressText(parseEmployeeScope(scope).origin)) : ''
              } catch {
                return ''
              }
            },
          }),
        'oryh address',
      )
      // Said only while rules the agent read in this conversation have changed and it has not read them
      // again (rule-watch.ts): what it can still see of them above is no longer the tenant's rule.
      own(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'oryh-rules-changed',
            order: 10002,
            text: () => plainPromptText(this.rules.notice(String(agent.id))),
          }),
        'oryh rule changes',
      )
      own(() => () => this.rules.forget(String(agent.id)), 'oryh rule watch')
      own(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'oryh-current-page',
            order: 10000,
            text: () => {
              try {
                return jsonPromptText(currentPage(this.pane, String(agent.id)))
              } catch {
                return NO_PAGE_CONTEXT
              }
            },
          }),
        'oryh page context',
      )
    }
    this.mcpTools.install()
    // Offer ORYH's tools as soon as any connection can list them, so a fresh session has them before a page binds.
    void this.options.controller.listConnections().then(
      connections => {
        for (const connection of connections) void this.mcpTools.refresh(connection.id).catch(() => {})
      },
      () => {},
    )
    // The event is awaited now, and a listener that fails fails the agent with it. Mounting is what puts
    // the tool policy and the page context in place before the first turn, so it belongs here — but a page
    // plugin that contributed a tool name nothing registered must not stop every session from starting.
    ctx.on('agent/disposed', ({ agent }) => {
      const held = mounted.get(agent)
      if (!held) return
      mounted.delete(agent)
      for (const dispose of held.reverse()) {
        try {
          void dispose()
        } catch {
          /* one that will not come off does not keep the others on */
        }
      }
    })
    ctx.on('agent/created', ({ agent }) => {
      try {
        mount(agent)
      } catch (error) {
        ctx.logger?.warn?.(
          `ORYH could not mount its policy on a new session: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return undefined
    })
    ctx.agents.list().forEach(mount)
    const refused = (exec: { agent?: { id: unknown } | undefined; name: string; arguments: unknown }) =>
      exec.agent
        ? this.refusal(String(exec.agent.id), exec.name, exec.arguments)
        : '这个工具不在 ORYH 客户端为本会话开放的工具中。业务操作请按对应的 ORYH skill 执行。'
    ctx.on('tools/pre-execute', async (exec, next) => {
      const reason = refused(exec)
      return reason === undefined ? next() : { kind: 'deny', reason }
    })
    // The same decision as a guard. The waterfall above can be reordered: a listener registered ahead of
    // it that allows without calling on would let through a write from a run that may only read. A guard
    // runs after the waterfall and nothing can undo its refusal.
    ctx.effect(() => ctx.tools.guard(exec => refused(exec)), 'oryh tool guard')
    // A shell step may have written to ORYH, like a call to one of its tools that is not read-only. The
    // session is marked as it happens and the marker is published when the turn ends, so pages re-read
    // once after the agent is done instead of between the reads it makes along the way.
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.agent && exec.name === 'bash') this.pane.markWrite(String(exec.agent.id))
      return decision
    })
    // The waterfall is awaited before the first model request. Runtime context is refreshed after it.
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      if (step === 1 && !this.runnerOf(String(agent.id)))
        await this.rules.check(String(agent.id), AbortSignal.any([signal, AbortSignal.timeout(3000)]))
      return next()
    })
    ctx.on('agent/status', ({ agent, status }) => {
      // A turn starts from the truth: whatever was verified before it is asked again, once.
      if (status === 'running') this.options.host?.forgetVerifications()

      if (status === 'idle') this.pane.turnEnded(String(agent.id))
    })
    ctx.effect(() => () => mounted.clear(), 'oryh business agent')
  }
}
