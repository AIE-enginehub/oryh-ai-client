import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { SubmitReviewState } from './types.js'
import type { CommandQueue } from './command-queue.js'

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
}

/** How long a review may run before the page stops waiting on it. */
const REVIEW_TIMEOUT_MS = 120_000

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/** The agent it runs on, narrowed to what a review needs. */
interface ReviewAgent { id: unknown; inbox: { nextTurn: readonly { id: string }[] }; followup: (message: ReturnType<typeof createUserMessage>) => void }

export class SubmitReview {
  private reviews = new Map<string, SubmitReviewState>()
  /** Identity of each pending request: while it is still in the inbox the review is queued behind a
   * conversation turn; once gone, the review turn itself is running. */
  private messages = new Map<string, string>()
  /** Why the last review turn died, kept until the status listener can report it. */
  private failures = new Map<string, string>()
  /** Timers that settle a review no turn ever finishes; cleared the moment it settles. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private ctx: Context, private queue: CommandQueue) {}

  /** The review the command stream publishes for this session. */
  state(id: string) { return this.reviews.get(id) }
  /** Whether a review is still waiting on the agent, and so may still be settled. */
  private live(id: string) { const s = this.reviews.get(id)?.status; return s === 'queued' || s === 'reviewing' }
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
   * progress reaches the page over the command stream.
   * @param id - session whose agent performs the review.
   * @param review - what is being submitted, named as ORYH names it.
   */
  start(id: string, review: ReviewRequest): void {
    const agent = this.ctx.agents.get(id as never) as ReviewAgent | undefined
    if (!agent) throw fail('当前会话不可用，无法进行规范核对。')
    const request = createUserMessage({ content: [{ type: 'text',
      // The object type is the server's key for the definitions and belongs in the request; the
      // label is what a person calls the document, and leading with it keeps `timesheet_header`
      // out of the verdict the user ends up reading.
      text: `（提交动作触发）请按本企业对${review.label}的流程定义核对这张待提交的${review.label}（编号 ${review.documentId}；流程定义的 object_type 是 ${review.objectType}）。${review.read}，再调用 oryh_review_result 回报结论；结论里用“${review.label}”称呼它，不要出现 object_type；不要修改表单。` }], source: { kind: 'user' } })
    agent.followup(request)
    this.messages.set(id, String(request.id))
    this.settled(id)
    // Backstop for an agent that neither reports nor goes idle. The status listener catches the
    // common failure within a second; this only covers a driver that hangs, and is generous because
    // a review queued behind a long conversation turn is legitimately slow.
    this.timers.set(id, setTimeout(() => this.failed(id, '核对超时，未收到结论。'), REVIEW_TIMEOUT_MS))
    this.reviews.set(id, { objectType: review.objectType, documentId: review.documentId, label: review.label, status: this.phase(id, agent) })
    this.queue.changed(id)
  }

  /**
   * Mark the review as actually running.
   *
   * Subscribing to `agent/status` alone is not enough: idle -> running fires before the driver
   * drains the inbox, so the request still looks queued, and no further status event arrives before
   * the verdict. The review turn's own first tool call is the dependable signal.
   * @param id - session whose review turn has started doing work.
   */
  claimed(id: string): void {
    const current = this.reviews.get(id)
    if (!current || current.status !== 'queued') return
    this.reviews.set(id, { ...current, status: 'reviewing' })
    this.queue.changed(id)
  }

  /** Drop the review, whether the page moved on or the submission finished. */
  clear(id: string): void {
    this.messages.delete(id)
    this.settled(id)
    if (this.reviews.delete(id)) this.queue.changed(id)
  }

  /**
   * Refuse a submit the norm review has not cleared.
   *
   * Only `passed` opens the door — a flagged verdict, a review still running, and a review that
   * could not run at all all block. That is deliberate: any state the user can reach by waiting or
   * by closing the session would otherwise be a way around the verdict, and then the check is
   * decoration. The submitter still has ORYH Console and any other agent; what this removes is
   * *this* client being the easy way past its own review.
   * @param objectType - ORYH object type being confirmed.
   * @param documentId - document being confirmed; a verdict about another one does not clear it.
   * @param sessionId - chat session whose agent ran the review.
   */
  assertPassed(objectType: string, documentId: string | undefined, sessionId?: string): void {
    const review = sessionId === undefined ? undefined : this.reviews.get(sessionId)
    if (review?.status === 'passed' && review.objectType === objectType && review.documentId === documentId) return
    if (review?.status === 'flagged') throw fail(`未通过企业流程要求核对：${review.message || '存在冲突'}。请修改后重新提交。`)
    if (review?.status === 'queued' || review?.status === 'reviewing') throw fail('规范核对尚未完成，请等待结论。')
    throw fail('本次提交未经企业流程要求核对，无法提交。请在 Chat 中保持会话后重新提交。')
  }

  /**
   * Settle a review the agent never reported on.
   *
   * `unavailable` is a terminal state, not a pause: the page offers a retry and keeps the confirm
   * button disabled. Reporting the underlying failure verbatim matters more than tidy wording — a
   * quota error or a dead model is something only the user can act on, and "核对失败" says nothing.
   * @param id - session whose review failed.
   * @param message - the reason, shown to the user as-is.
   */
  private failed(id: string, message: string): void {
    const current = this.reviews.get(id)
    if (!current || !this.live(id)) return
    this.settled(id)
    this.reviews.set(id, { ...current, status: 'unavailable', message })
    this.queue.changed(id)
  }

  /** Drop the bookkeeping a settled review no longer needs. */
  private settled(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) { clearTimeout(timer); this.timers.delete(id) }
    this.failures.delete(id)
  }

  /** Register the verdict tool and the listeners that settle a review nobody reports on. */
  install(): void {
    const output = { schema: { type: 'string' as const }, render: (_a: unknown, value: string) => [{ type: 'text' as const, text: value }] }
    this.ctx.tools.register(defineTool({ name: 'oryh_review_result',
      description: '回报一次提交前的规范核对结论。只在收到“（提交动作触发）”的核对请求后调用，且必须先按请求里说的方式读过实际内容。verdict=passed 表示未发现与企业流程要求冲突；verdict=flagged 表示存在冲突，message 用一两句话说明是哪一条、具体差多少，供用户判断。这不是保存或提交，用户仍需在页面确认。',
      parameters: { verdict: { type: 'string', required: true, enum: ['passed', 'flagged'] }, message: { type: 'string', required: true, description: 'flagged 时说明冲突；passed 时可留空字符串' } },
      output,
      execute: async (args, e) => {
        if (!e.agent) throw fail('需要会话')
        const id = String(e.agent.id), current = this.reviews.get(id)
        if (!current) return '当前没有待回报的核对请求，结论已忽略。'
        // The page moved on, or the review already settled without the agent: a verdict about a
        // finished review is noise, and must not revive it.
        if (!this.live(id)) return '该核对请求已结束，结论已忽略。'
        this.settled(id)
        this.reviews.set(id, { ...current, status: args.verdict === 'passed' ? 'passed' : 'flagged', message: String(args.message ?? '') })
        this.queue.changed(id)
        return '核对结论已回报给页面，等待用户确认。'
      } }))

    // A turn that dies takes the verdict with it. The failure itself is the only place the reason
    // exists (a model quota error, say), and the page is blocked until something settles the review.
    this.ctx.on('agent/error' as never, (({ agent, error }: { agent: { id: unknown }; error: unknown }) => {
      const id = String(agent.id)
      if (this.live(id)) this.failures.set(id, error instanceof Error ? error.message : String(error))
    }) as never)

    this.ctx.on('agent/status' as never, (({ agent, status }: { agent: ReviewAgent; status?: string }) => {
      const id = String(agent.id), current = this.reviews.get(id)
      if (!current || !this.live(id)) return
      const phase = this.phase(id, agent)
      // Idle with the request gone from the inbox means the review turn ran and ended without
      // reporting. Before submitting was gated on the verdict this only cost a stale label; now it
      // is what stands between the user and a submit, so it has to settle rather than spin forever.
      // The inbox is the authority here, not our own label: `claimed()` can be raised early by an
      // unrelated turn's tool call, and that must not be mistaken for a review that has run.
      if (status === 'idle' && phase === 'reviewing') { this.failed(id, this.failures.get(id) ?? '核对回合已结束但没有回报结论。'); return }
      if (phase === current.status) return
      this.reviews.set(id, { ...current, status: phase })
      this.queue.changed(id)
    }) as never)

    this.ctx.effect(() => () => {
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.reviews.clear(); this.messages.clear(); this.failures.clear(); this.timers.clear()
    }, 'oryh submit reviews')
  }
}
