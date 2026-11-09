import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  applyChildComposition,
  finalAssistantOutput,
  type ResolvedSubagentStartRequest,
  type SubagentActivation,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { OryhClientError } from '@oryh/ai-client-foundation'
import {
  catalogRun,
  describeRun,
  lastAssistantText,
  lastTurnEnd,
  oneShotDescriptor,
  stopReasonOf,
} from './child-run.js'
import type { Clock } from './clock.js'
import { composed } from './composed.js'
import type { PaneService } from './service.js'
import { textOutput } from './tools.js'
import type { SubmitReviewState } from './types.js'

/**
 * Pre-submit norm review, for any document ORYH governs with a workflow definition.
 *
 * The middle pane's submit buttons call the API directly, so an enterprise norm — which lives in the
 * tenant's workflow definitions and in ORYH's Skills, never in this code — would not reach them. The
 * page therefore asks the session's agent to read the document and judge it, and refuses to submit
 * until the agent says it passes. See docs/22.
 *
 * One review per session at a time: a person confirms one document at a time, and a single slot is
 * what makes a late verdict about an abandoned document obviously stale rather than ambiguous.
 *
 * The review runs in a session of its own, under the Chat it was asked from (docs/56 §24). It used to
 * be put to the Chat itself as a turn of the person's: a sentence they never wrote stood in their
 * conversation, and a review asked for while the agent was busy — or waiting on an answer from them —
 * queued behind that, sometimes for good. Apart, it starts at once, reads the same page and the same
 * ORYH as the person, can write nothing, and leaves the conversation as the person had it; Harness lists
 * it under the Chat, where its own conversation can be opened. Where Harness cannot run one apart, the
 * Chat is asked as before.
 */

/**
 * One document under review, named the way ORYH names it.
 *
 * `objectType` is the server's own vocabulary (`timesheet_header`, `expense_claim`,
 * `purchase_request`, a tenant's custom object…). Nothing here enumerates which types exist: the
 * tenant's workflow definitions decide that, and a page that can submit a type describes itself.
 */
export interface ReviewRequest {
  /** ORYH object type, as the workflow definition names it. */
  objectType: string
  /** The document being submitted; a verdict about any other one is stale. */
  documentId: string
  /** What to call this document to a person, e.g. 工时单. */
  label: string
  /** How the agent should read it, e.g. `先用 oryh_timesheet_read 读取实际内容`. */
  read: string
  /**
   * How the request points at the document, where `documentId` is not a number ORYH knows it by — a
   * draft this client keeps. Given a local draft's id as "编号", a reviewer asked ORYH for it, was told
   * there was no such claim, and went through the person's claims looking for the one it meant.
   */
  reference?: string
}

/** How long a review asked of the Chat may take, queueing included, before the page stops waiting on it. */
const REVIEW_TIMEOUT_MS = 120_000
/**
 * How long a review in a session of its own may run. It reads the document, the tenant's definitions and
 * what it compares them with, at the Chat's own reasoning effort: a real one took 100 seconds (docs/56
 * §27). A run that fails ends and says so at once; this only stops one that hangs.
 */
const REVIEW_APART_TIMEOUT_MS = 300_000

/** The subagent provider reviews start through. Only this service starts with it: no tool names it. */
export const REVIEW_PROVIDER = 'oryh-submit-review'

/**
 * What a review's own session may call, besides ORYH's reads: the skills that hold the tenant's norms,
 * the page as the person has it, and the verdict. What a page's own reader is called is added by the
 * plugin that asks for reviews ({@link SubmitReview.reader}).
 */
const REVIEW_TOOLS = ['skill', 'oryh_current_page', 'oryh_review_result']

/** What the reviewer is asked: the same request whether it runs apart or as a turn of the Chat. */
const requestText = (review: ReviewRequest) =>
  // The object type is the server's key for the rules and belongs in the request; the label is what a
  // person calls the document, and leading with it keeps `timesheet_header` out of the verdict the user
  // ends up reading. They are business rules in ORYH's words: asked for "流程定义", a reviewer went
  // looking for paths by that name, which ORYH no longer has.
  `（提交动作触发）请按本企业对${review.label}发布的业务规则核对这张待提交的${review.label}（${review.reference ?? `编号 ${review.documentId}`}；业务规则的 object_type 是 ${review.objectType}）。${review.read}，再调用 oryh_review_result 回报结论；结论里用“${review.label}”称呼它，不要出现 object_type；不要修改表单。`

/** The standing instructions of a review's own session. */
const reviewInstructions = (clock: Clock) =>
  [
    '这是一次提交前的规范核对，在独立的会话里进行：用户看不到这里的对话，只看得到你最后回报的结论。',
    '只读取，不修改任何单据或表单，也不向用户提问。先按请求读取单据的实际内容，再按本企业对这类单据发布的业务规则和对应的 skill 判断它是否符合要求。',
    '判断之前先在技能目录里找到处理这类单据的 skill，用 skill 工具装载；业务规则读哪个接口、怎么读，以它说的为准，不要自己猜接口路径。技能已经属于当前账号，不需要也不能调用 oryh_skill_sync。',
    '判断完必须调用 oryh_review_result 回报结论：passed 表示未发现与企业流程要求冲突；flagged 表示存在冲突，用一两句话说明是哪一条、具体差多少。',
    '读不到单据、或找不到适用的业务规则和 skill 时，不要回报结论，也不要臆测通过：用一两句话说明原因后结束。',
    `今天是 ${clock.today}（星期${'一二三四五六日'[clock.weekday - 1] ?? ''}），用户所在时区 ${clock.timeZone}。`,
  ].join('')

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/** The agent it runs on, narrowed to what a review needs. */
interface ReviewAgent {
  id: unknown
  inbox: { nextTurn: readonly { id: string }[] }
  followup: (message: ReturnType<typeof createUserMessage>) => void
}

export class SubmitReview {
  private starts = new Map<string, symbol>()
  private reviews = new Map<string, SubmitReviewState>()
  /** Reviews running in a session of their own, by the session that asked: how to stop each. */
  private apart = new Map<string, AbortController>()
  /** Each review's own session, and the session it reviews for. */
  private sessions = new Map<string, string>()
  /** The tools pages name in their requests for reading what is to be reviewed. */
  private readers = new Set<string>()
  /** Identity of each pending request: while it is still in the inbox the review is queued behind a
   * conversation turn; once gone, the review turn itself is running. */
  private messages = new Map<string, string>()
  /** Why the last review turn died, kept until the status listener can report it. */
  private failures = new Map<string, string>()
  /** Timers that settle a review no turn ever finishes; cleared the moment it settles. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    private ctx: Context,
    private pane: PaneService,
  ) {}

  /** The review the pane stream publishes for this session. */
  state(id: string): SubmitReviewState | undefined {
    return this.reviews.get(id)
  }
  /** Whether a session is a review's own: it is then given a review's tools and nothing of the Chat's. */
  owns(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }
  /** What a review's own session may call, for the agent's policy. */
  get tools(): readonly string[] {
    return [...REVIEW_TOOLS, ...this.readers]
  }
  /**
   * Name a tool a page's requests tell the reviewer to read with, so a review's own session has it.
   * It must only read: a review writes nothing.
   */
  reader(tool: string): void {
    this.readers.add(tool)
  }
  /** The session a tool call belongs to as far as reviews go: a review's own session speaks for the one it reviews for. */
  private of(sessionId: string): string {
    return this.sessions.get(sessionId) ?? sessionId
  }
  /** Whether a review is still waiting on the agent, and so may still be settled. */
  private live(id: string) {
    const s = this.reviews.get(id)?.status
    return s === 'queued' || s === 'reviewing'
  }
  /** Queued while the request is still pending in the inbox; reviewing once the agent claimed it. */
  private phase(id: string, agent: ReviewAgent): 'queued' | 'reviewing' {
    const message = this.messages.get(id)
    return message !== undefined && agent.inbox.nextTurn.some(m => String(m.id) === message) ? 'queued' : 'reviewing'
  }

  /**
   * Ask the session's agent to check this document against the enterprise norms before submitting.
   *
   * `followup` is the right door: it queues the request as its own turn AND wakes an idle driver. A
   * bare `inbox.append` only queues — with the agent idle, which is the common case when someone
   * clicks submit, the message sits in the chat forever and no turn ever runs. Nothing here blocks;
   * progress reaches the page over the pane stream.
   */
  async start(id: string, review: ReviewRequest): Promise<void> {
    // A review still running for this session is about a document the person has moved on from.
    this.stop(id)
    this.settled(id)
    // A session the person reopened has no agent until they speak in it; the pane brings it back, so a
    // submit made straight from the page is reviewed like any other.
    const token = Symbol()
    this.starts.set(id, token)
    const chat = await this.pane.agentOf(id)
    if (this.starts.get(id) !== token) return
    if (await this.startApart(id, chat, review, token)) return
    if (this.starts.get(id) !== token) return
    const agent: ReviewAgent = chat
    const request = createUserMessage({
      content: [{ type: 'text', text: requestText(review) }],
      source: composed({ by: 'review' }),
    })
    agent.followup(request)
    this.messages.set(id, String(request.id))
    this.settled(id)
    // Backstop for an agent that neither reports nor goes idle. The status listener catches the
    // common failure within a second; this only covers a driver that hangs, and is generous because
    // a review queued behind a long conversation turn is legitimately slow.
    this.timers.set(
      id,
      setTimeout(() => this.failed(id, '核对超时，未收到结论。'), REVIEW_TIMEOUT_MS),
    )
    this.reviews.set(id, {
      objectType: review.objectType,
      documentId: review.documentId,
      label: review.label,
      status: this.phase(id, agent),
    })
    this.pane.changed(id)
  }

  /**
   * Run the review in a session of its own under the Chat, where Harness can.
   * @returns false when it could not be started that way, and the Chat itself is to be asked.
   */
  private async startApart(id: string, chat: Agent, review: ReviewRequest, token: symbol): Promise<boolean> {
    const subagents = this.ctx.get('subagents')
    if (!subagents) return false
    const cancel = new AbortController()
    const mine = () => this.apart.get(id) === cancel
    let run: SubagentActivation
    let unregister: (() => void) | undefined
    try {
      const workspaceId = await this.pane.userViews.workspace(id)
      const workspace = this.ctx
        .get('workspaceRegistry')
        ?.list()
        .find(candidate => candidate.id === workspaceId)
      if (!workspace) return false
      if (this.starts.get(id) !== token) return true
      const selection =
        chat.options.provider && chat.options.model
          ? { provider: chat.options.provider, model: chat.options.model }
          : this.ctx.get('agentDefaultModel')?.currentSelection()
      // One provider closure per start: the manager deliberately replaces the caller's signal.
      const provider = `${REVIEW_PROVIDER}:${randomUUID()}`
      unregister = subagents.registerProvider({
        name: provider,
        capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
        inheritsParentContext: false,
        start: request => this.startRunner(request, { sessionId: id, cwd: workspace.path }),
      })
      // Reviewing from the moment it is asked: nothing stands ahead of it.
      this.apart.set(id, cancel)
      this.reviews.set(id, {
        objectType: review.objectType,
        documentId: review.documentId,
        label: review.label,
        status: 'reviewing',
      })
      this.pane.changed(id)
      this.timers.set(
        id,
        setTimeout(() => {
          if (!mine()) return
          this.failed(id, '核对超时，未收到结论。')
          cancel.abort()
        }, REVIEW_APART_TIMEOUT_MS),
      )
      run = await subagents.startActivation({
        provider,
        delivery: 'caller',
        label: `核对${review.label}`,
        request: {
          cwd: workspace.path,
          prompt: [{ type: 'text', text: requestText(review) }],
          parent: chat,
          ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
        },
        signal: cancel.signal,
      })
    } catch (error) {
      // Not started: nothing of it is left standing, and the Chat is asked instead.
      if (this.apart.get(id) === cancel) {
        this.apart.delete(id)
        this.settled(id)
        if (!cancel.signal.aborted) this.reviews.delete(id)
      }
      this.ctx.logger?.warn?.(
        `ORYH review could not run in a session of its own: ${error instanceof Error ? error.message : String(error)}`,
      )
      return cancel.signal.aborted
    } finally {
      unregister?.()
    }
    const dispose = () => {
      void run.dispose().catch(error => this.ctx.logger?.warn?.(`ORYH review cleanup failed: ${String(error)}`))
    }
    cancel.signal.addEventListener('abort', dispose, { once: true })
    if (cancel.signal.aborted) dispose()
    if (!mine()) {
      dispose()
      return true
    }
    // A run that ends without the verdict takes it with it; its last words are the only reason there is.
    void run.result
      .then(
        result => {
          if (!mine() || !this.live(id)) return
          const words = lastAssistantText([{ role: 'assistant', content: result.output }])
          this.failed(id, this.failures.get(id) ?? words ?? '核对已结束但没有回报结论。')
        },
        (error: unknown) => {
          if (mine()) this.failed(id, error instanceof Error ? error.message : String(error))
        },
      )
      .finally(() => {
        cancel.signal.removeEventListener('abort', dispose)
        if (mine()) this.apart.delete(id)
        dispose()
      })
    return true
  }

  /**
   * Establish one review's session for Harness's subagent service, which asks for it with the review's
   * own signal. A child of the Chat at runtime and in its lineage, as Harness's own subagents are: it
   * stops with the Chat, and is listed under it.
   */
  private async startRunner(
    request: ResolvedSubagentStartRequest,
    launch: { sessionId: string; cwd: string },
  ): Promise<SubagentRun> {
    const { parent } = request
    const sessionId = SessionId(`session-${randomUUID()}`)
    // Known before it exists: the tool policy goes on as the session is announced, and must already see
    // it as a review's. It reads the pane of the session it reviews for — the page, and whose ORYH.
    this.sessions.set(String(sessionId), launch.sessionId)
    const leave = this.pane.standIn(String(sessionId), launch.sessionId)
    const release = () => {
      this.sessions.delete(String(sessionId))
      leave()
    }
    let handle: AgentHandle
    try {
      handle = await parent.ctx.agents.create({
        sessionId,
        parentAgent: parent,
        meta: { cwd: launch.cwd, origin: 'subagent', parentSession: parent.id },
        ...(request.agentOptions ? { agentOptions: request.agentOptions } : {}),
        signal: request.signal,
        setup: async child => {
          // The Chat's own composition first. The `skill` tool and the catalogue of this account's skills
          // come with the agent preset, not from the Host, and a child that joins no preset has neither:
          // a review could not load the skill that says where the tenant's rules are, tried to read skills
          // over REST instead, and guessed at paths. What it may call is still only what a review is given.
          await applyChildComposition(child, parent, {})
          // Beside the standing rules and the skill catalog, not in their place: the norms are in skills.
          child.systemPrompt.section({
            name: 'oryh-submit-review',
            order: 20000,
            interpolate: false,
            text: reviewInstructions(this.pane.clock(launch.sessionId)),
          })
          describeRun(child, oneShotDescriptor(REVIEW_PROVIDER, request.label))
        },
      })
    } catch (error) {
      release()
      throw error
    }
    const agent = handle.agent
    try {
      catalogRun(parent, agent, request.label)
    } catch (error) {
      release()
      await handle.dispose()
      throw error
    }
    if (request.label) {
      try {
        this.ctx.get('sessionTitle')?.rename(agent.session, request.label)
      } catch {
        /* an automatic title is no harm */
      }
    }
    const stop = () => agent.cancel({ kind: 'user' })
    request.signal.addEventListener('abort', stop, { once: true })
    if (request.signal.aborted) stop()
    const result = (async (): Promise<SubagentResult> => {
      agent.followup(createUserMessage({ source: composed({ by: 'review' }), content: request.prompt }))
      await agent.whenIdle()
      return {
        output: finalAssistantOutput(agent.session.ownEvents()) ?? [],
        stopReason: stopReasonOf(lastTurnEnd(agent.session), request.signal.aborted),
      }
    })()
    let disposal: Promise<void> | undefined
    return {
      // The external activation id must not collide with any local Agent/Session.
      // The real, navigable child remains the one-shot Session recorded in the parent catalog.
      id: SessionId(`oryh-activation-${randomUUID()}`),
      result,
      dispose: () =>
        (disposal ??= (async () => {
          request.signal.removeEventListener('abort', stop)
          release()
          const [disposed] = await Promise.allSettled([handle.dispose(), result])
          if (disposed.status === 'rejected') throw disposed.reason
        })()),
    }
  }

  /** Stop a review running in a session of its own: its document was abandoned, or its time is up. */
  private stop(id: string): void {
    const cancel = this.apart.get(id)
    if (!cancel) return
    this.apart.delete(id)
    cancel.abort()
  }

  /**
   * Mark the review as actually running.
   *
   * Subscribing to `agent/status` alone is not enough: idle -> running fires before the driver
   * drains the inbox, so the request still looks queued, and no further status event arrives before
   * the verdict. The review turn's own first tool call is the dependable signal.
   */
  claimed(session: string): void {
    const id = this.of(session)
    const current = this.reviews.get(id)
    if (!current || current.status !== 'queued') return
    this.reviews.set(id, { ...current, status: 'reviewing' })
    this.pane.changed(id)
  }

  /** Drop the review, whether the page moved on or the submission finished. */
  clear(id: string): void {
    this.starts.delete(id)
    this.stop(id)
    this.messages.delete(id)
    this.settled(id)
    if (this.reviews.delete(id)) this.pane.changed(id)
  }

  /**
   * Refuse a submit the norm review has not cleared.
   *
   * Only `passed` opens the door — a flagged verdict, a review still running, and a review that
   * could not run at all all block. That is deliberate: any state the user can reach by waiting or
   * by closing the session would otherwise be a way around the verdict, and then the check is
   * decoration. The submitter still has ORYH Console and any other agent; what this removes is
   * *this* client being the easy way past its own review.
   */
  assertPassed(objectType: string, documentId: string | undefined, sessionId?: string): void {
    const review = sessionId === undefined ? undefined : this.reviews.get(sessionId)
    if (review?.status === 'passed' && review.objectType === objectType && review.documentId === documentId) return
    if (review?.status === 'flagged')
      throw fail(`未通过企业流程要求核对：${review.message || '存在冲突'}。请修改后重新提交。`)
    if (review?.status === 'queued' || review?.status === 'reviewing') throw fail('规范核对尚未完成，请等待结论。')
    throw fail('本次提交未经企业流程要求核对，无法提交。请在 Chat 中保持会话后重新提交。')
  }

  /**
   * Settle a review the agent never reported on.
   *
   * `unavailable` is a terminal state, not a pause: the page offers a retry and keeps the confirm
   * button disabled. Reporting the underlying failure verbatim matters more than tidy wording — a
   * quota error or a dead model is something only the user can act on, and "核对失败" says nothing.
   */
  private failed(id: string, message: string): void {
    const current = this.reviews.get(id)
    if (!current || !this.live(id)) return
    this.settled(id)
    this.reviews.set(id, { ...current, status: 'unavailable', message })
    this.pane.changed(id)
  }

  /** Drop the bookkeeping a settled review no longer needs. */
  private settled(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.failures.delete(id)
  }

  /** Register the verdict tool and the listeners that settle a review nobody reports on. */
  install(): void {
    this.ctx.effect(
      () =>
        this.pane.provideState(id => {
          const review = this.reviews.get(id)
          return review ? { review } : {}
        }),
      'oryh review state',
    )
    this.ctx.tools.register(
      defineTool({
        name: 'oryh_review_result',
        description:
          '回报一次提交前的规范核对结论。只在收到“（提交动作触发）”的核对请求后调用，且必须先按请求里说的方式读过实际内容。verdict=passed 表示未发现与企业流程要求冲突；verdict=flagged 表示存在冲突，message 用一两句话说明是哪一条、具体差多少，供用户判断。这不是保存或提交，用户仍需在页面确认。',
        parameters: {
          verdict: { type: 'string', required: true, enum: ['passed', 'flagged'] },
          message: { type: 'string', required: true, description: 'flagged 时说明冲突；passed 时可留空字符串' },
        },
        output: textOutput,
        execute: async (args, e) => {
          if (!e.agent) throw fail('需要会话')
          // A review's own session reports for the session it reviews for.
          const id = this.of(String(e.agent.id)),
            current = this.reviews.get(id)
          if (!current) return '当前没有待回报的核对请求，结论已忽略。'
          // The page moved on, or the review already settled without the agent: a verdict about a
          // finished review is noise, and must not revive it.
          if (!this.live(id)) return '该核对请求已结束，结论已忽略。'
          this.settled(id)
          this.reviews.set(id, {
            ...current,
            status: args.verdict === 'passed' ? 'passed' : 'flagged',
            message: String(args.message ?? ''),
          })
          this.pane.changed(id)
          return '核对结论已回报给页面，等待用户确认。'
        },
      }),
    )

    // A turn that dies takes the verdict with it. The failure itself is the only place the reason
    // exists (a model quota error, say), and the page is blocked until something settles the review.
    this.ctx.on('agent/disposed', ({ agent }) => {
      const id = String(agent.id)
      this.starts.delete(id)
      this.stop(id)
      this.settled(id)
    })

    this.ctx.on('agent/error', ({ agent, error }) => {
      const id = this.of(String(agent.id))
      if (this.live(id)) this.failures.set(id, error instanceof Error ? error.message : String(error))
    })

    this.ctx.on('agent/status', ({ agent, status }) => {
      const id = String(agent.id),
        current = this.reviews.get(id)
      // A review running apart settles by its own run: what the Chat's turns do says nothing of it.
      if (!current || !this.live(id) || this.apart.has(id)) return
      const phase = this.phase(id, agent)
      // Idle with the request gone from the inbox means the review turn ran and ended without
      // reporting. Before submitting was gated on the verdict this only cost a stale label; now it
      // is what stands between the user and a submit, so it has to settle rather than spin forever.
      // The inbox is the authority here, not our own label: `claimed()` can be raised early by an
      // unrelated turn's tool call, and that must not be mistaken for a review that has run.
      if (status === 'idle' && phase === 'reviewing') {
        this.failed(id, this.failures.get(id) ?? '核对回合已结束但没有回报结论。')
        return
      }
      if (phase === current.status) return
      this.reviews.set(id, { ...current, status: phase })
      this.pane.changed(id)
    })

    this.ctx.effect(
      () => () => {
        for (const timer of this.timers.values()) clearTimeout(timer)
        for (const cancel of this.apart.values()) cancel.abort()
        this.starts.clear()
        this.apart.clear()
        this.sessions.clear()
        this.reviews.clear()
        this.messages.clear()
        this.failures.clear()
        this.timers.clear()
      },
      'oryh submit reviews',
    )
  }
}
