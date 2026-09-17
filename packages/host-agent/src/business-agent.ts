import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OryhClientController, OryhClientHost, OryhMcpClient, OryhSkillService } from '@oryh/ai-client-core'
import { OryhClientError, parseEmployeeScope } from '@oryh/ai-client-foundation'
import type { ChatCapabilities } from '@oryh/dsh-connection'
import { currentPage, NO_PAGE_CONTEXT, type PaneService, textOutput } from '@oryh/dsh-pane'
import { answerShape, resourceOf } from './follow.js'
import { OryhMcpTools } from './mcp-tools.js'
import { instructions } from './prompts.js'

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
}

// 'skill' and 'bash' are what make the Chat pane a generic ORYH agent (ADR-0009): ORYH's business
// logic arrives as skills, and the shell is for the local work a request may need. What still bounds
// the agent is the API's own require_permission and a catalog that only carries the holder's skills.
const BASE_TOOLS: readonly string[] = ['skill', 'bash', 'oryh_skill_sync']

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
        this.pane.markWrite(id)
        void this.followWrite(id, args, text)
      },
      (id, args, text) => {
        void this.followRead(id, args, text)
      },
    )
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
    const base = this.options.capabilities.shell ? BASE_TOOLS : BASE_TOOLS.filter(name => name !== 'bash')
    return [...base, ...this.pane.contributions().flatMap(contribution => contribution.tools ?? [])]
  }

  private allowedTools(): string[] {
    return [...this.ownTools(), ...this.mcpTools.names]
  }

  /** The standing rules, with what the pages added. */
  instructions(): string {
    return instructions(
      this.options.capabilities,
      this.pane.contributions().flatMap(contribution => contribution.prompt ?? []),
    )
  }

  private known(resource: string): boolean {
    return this.pane.pageOf(resource) !== undefined
  }

  /**
   * Show in the business pane what the agent just read (docs/13 §1: the middle pane is what this is now).
   *
   * Telling the agent to open the page does not survive contact with a skill that only describes how to
   * read the data — it answers in chat and the pane stays where it was. So the pane follows the call
   * itself. Best effort and silent: no pane, no permission, or a navigation already in flight all mean
   * nothing happens here.
   */
  private async followRead(sessionId: string, args: unknown, text: string): Promise<void> {
    try {
      if (!answerShape(text).list) return
      const resource = resourceOf(args, r => this.known(r))
      await this.pane.showPage(sessionId, resource ? this.pane.pageOf(resource) : undefined)
    } catch {
      /* following the conversation is best effort; a failure must not disturb the call */
    }
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
      const resource = resourceOf(args, r => this.known(r))
      if (!resource) return
      const { id } = answerShape(text)
      const opener = this.pane.contributions().find(c => c.resources?.[resource] !== undefined && c.open)
      if (id && opener?.open && this.pane.session(sessionId)?.page !== undefined) {
        await opener.open(sessionId, resource, id)
        return
      }
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
    // Deliberately NOT `complete: true`. That flag restores this section as the *sole* prompt
    // section, which also drops the skill catalog — leaving the agent holding the `skill` tool with
    // no idea which skills exist. Under ADR-0009 the Chat pane is a generic ORYH agent, so the
    // catalog has to survive and this section steers rather than replaces.
    ctx.systemPrompt.section({ name: 'oryh-business-assistant', order: 10000, text: this.instructions() })
    const mounted = new Set<Agent>()
    const mount = (agent: Agent) => {
      if (mounted.has(agent)) return
      mounted.add(agent)
      // The allow-list grows when a page plugin or ORYH's MCP tools register, so the restriction is
      // re-applied: the new one goes on before the old comes off, and the agent never sees more than
      // either allows.
      ctx.effect(() => {
        let lift = agent.ctx.tools.restrict({ allow: this.allowedTools() })
        const reapply = () => {
          const next = agent.ctx.tools.restrict({ allow: this.allowedTools() })
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
      ctx.effect(() => agent.ctx.tools.presentAs('native'), 'oryh native business tools')
      ctx.effect(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'oryh-skill-identity',
            order: 10001,
            text: () => this.skillIdentity(String(agent.id)),
          }),
        'oryh skill identity',
      )
      ctx.effect(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'oryh-current-page',
            order: 10000,
            text: () => {
              try {
                return JSON.stringify(currentPage(this.pane, String(agent.id)))
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
    ctx.on('agent/created', ({ agent }) => mount(agent))
    ctx.agents.list().forEach(mount)
    ctx.on('tools/pre-execute', async (exec, next) =>
      this.allowedTools().includes(exec.name) && exec.agent
        ? next()
        : {
            kind: 'deny',
            reason: '这个工具不在 ORYH 客户端为本会话开放的工具中。业务操作请按对应的 ORYH skill 执行。',
          },
    )
    // A shell step may have written to ORYH, like a call to one of its tools that is not read-only. The
    // session is marked as it happens and the marker is published when the turn ends, so pages re-read
    // once after the agent is done instead of between the reads it makes along the way.
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.agent && exec.name === 'bash') this.pane.markWrite(String(exec.agent.id))
      return decision
    })
    ctx.on('agent/status', ({ agent, status }) => {
      // A turn starts from the truth: whatever was verified before it is asked again, once.
      if (status === 'running') this.options.host?.forgetVerifications()
      if (status === 'idle') this.pane.turnEnded(String(agent.id))
    })
    ctx.effect(() => () => mounted.clear(), 'oryh business agent')
  }
}
