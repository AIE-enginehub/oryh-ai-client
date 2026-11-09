import { describe, expect, it, vi } from 'vitest'
import { PaneService } from '../src/service.js'
import { REVIEW_PROVIDER, SubmitReview } from '../src/submit-review.js'
import {
  connectionId,
  fakeAgent,
  fakeConnection,
  fakeContext,
  fakeController,
  fakeSubagents,
  paneSyncer,
  tempDirectory,
  until,
} from '../src/testing.js'
import { UserViewRegistry } from '../src/user-views.js'

const request = {
  objectType: 'timesheet_header',
  documentId: 'h-1',
  label: '工时单',
  read: '先用 oryh_timesheet_read 读取实际内容',
}

/** A review's own session, as Harness would run it: it ends when the test says, with what the test gives it. */
interface Child {
  id: string
  section: string
  /** Whether it joined the composition of the Chat it works for. */
  joined: boolean
  prompt: string
  cancelled: boolean
  /** End the run's turn, having said this and nothing more. */
  end(words?: string): void
}

/**
 * The review service on a Host where Harness can run a session apart — or, with `apart: false`, where its
 * subagent service is not mounted, and with `broken`, where it is but cannot start one.
 */
async function setup(options: { apart?: boolean; broken?: boolean } = {}) {
  const temp = await tempDirectory()
  const chat = Object.assign(fakeAgent(), { options: { provider: 'deepseek', model: 'flash' } })
  const said: string[] = []
  chat.followup = (message: { id: string; content?: { text?: string }[] }) => {
    said.push(String(message.content?.[0]?.text))
    chat.inbox.nextTurn.push({ id: String(message.id) })
  }
  const harness = fakeContext(chat)
  const children: Child[] = []
  // What Harness gives a provider to make a child with.
  Object.assign(chat, {
    ctx: {
      agents: {
        create: async (spec: { sessionId: string; meta: unknown; setup: (ctx: unknown) => void }) => {
          const events: { type: string; data?: unknown }[] = []
          let idle!: () => void
          const child: Child = {
            id: String(spec.sessionId),
            section: '',
            joined: false,
            prompt: '',
            cancelled: false,
            end: words => {
              if (words)
                events.push({
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: words }] }, stream: [] },
                })
              events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
              idle()
            },
          }
          spec.setup({
            systemPrompt: {
              section: (section: { text: string }) => (child.section = section.text),
              context: () => {},
              getContextOrder: () => 0,
            },
            // What a child joins to get the Chat's `skill` tool and its catalogue: the parent's preset.
            get: (name: string) =>
              name === 'agentPresets'
                ? { composeFrom: (_child: unknown, parent: unknown) => (child.joined = parent === chat.ctx) }
                : undefined,
            on: () => {},
          })
          children.push(child)
          const agent = {
            id: spec.sessionId,
            session: { header: { createdAt: Date.now() }, ownEvents: () => events },
            followup: (message: { content?: { text?: string }[] }) => {
              child.prompt = String(message.content?.[0]?.text)
            },
            whenIdle: () => new Promise<void>(resolve => (idle = resolve)),
            cancel: () => {
              child.cancelled = true
              child.end()
            },
          }
          return {
            agent,
            dispose: async () => {
              agent.cancel()
            },
          }
        },
      },
    },
  })
  const pane = new PaneService(
    harness.ctx,
    fakeController(fakeConnection(), 1).controller,
    temp.directory,
    new UserViewRegistry(harness.ctx),
  )
  const reviews = new SubmitReview(harness.ctx, pane)
  const started: { provider: string; label?: string; agentOptions?: unknown }[] = []
  const subagents = fakeSubagents()
  const startActivation = subagents.startActivation.getMockImplementation()!
  subagents.startActivation.mockImplementation(async spec => {
    started.push({ provider: REVIEW_PROVIDER, label: spec.label, agentOptions: spec.request.agentOptions })
    if (options.broken) throw new Error('no child sessions here')
    return startActivation(spec)
  })
  const chatLog: unknown[] = []
  Object.assign(chat.session, { append: (type: string, data: unknown) => chatLog.push({ type, data }) })
  const services: Record<string, unknown> =
    options.apart === false
      ? {}
      : { subagents, workspaceRegistry: { list: () => [{ id: 'w1', path: '/work', sessionIds: ['s'] }] } }
  Object.assign(harness.ctx, { get: (name: string) => services[name] })
  reviews.install()
  reviews.reader('oryh_timesheet_read')
  await pane.bind({ sessionId: 's', connectionId })
  const page = paneSyncer(pane)
  page.sync('shipments', { key: 'timesheets:h-1', title: '10 月第 1 周', detail: '', scope: '' })
  const report = (session: string, verdict: 'passed' | 'flagged', message = '') =>
    harness
      .tool('oryh_review_result')
      .execute({ verdict, message }, { agent: { id: session }, callId: 'c', signal: new AbortController().signal })
  return { ...harness, pane, reviews, chat, said, children, started, subagents, chatLog, report, close: temp.close }
}

describe('a pre-submit review in a session of its own', () => {
  it('starts at once under the Chat, reads the pane of the session that asked, and reports for it', async () => {
    const f = await setup()
    try {
      await f.reviews.start('s', request)
      // Nothing was put to the Chat: the conversation is as the person had it.
      expect(f.said).toEqual([])
      expect(f.started).toEqual([
        { provider: REVIEW_PROVIDER, label: '核对工时单', agentOptions: { provider: 'deepseek', model: 'flash' } },
      ])
      // Reviewing from the moment it is asked: nothing stands ahead of it.
      expect(f.pane.frame('s').state.review).toMatchObject({ documentId: 'h-1', status: 'reviewing' })
      const child = f.children[0]!
      expect(child.prompt).toContain('（提交动作触发）')
      expect(child.prompt).toContain('编号 h-1')
      expect(child.section).toMatch(/只读取，不修改/)
      // With the Chat's composition under it: without that it has no skill tool and no catalogue of skills.
      expect(child.joined).toBe(true)
      expect(child.section).toMatch(/用 skill 工具装载/)
      expect(child.section).toMatch(/今天是 \d{4}-\d{2}-\d{2}/)
      // It is a review's session — given a review's tools — and sees the page the person is on.
      expect(f.reviews.owns(child.id)).toBe(true)
      expect(f.reviews.tools).toEqual(['skill', 'oryh_current_page', 'oryh_review_result', 'oryh_timesheet_read'])
      expect(f.pane.session(child.id)).toBe(f.pane.session('s'))
      expect(f.pane.page(child.id).context?.key).toBe('timesheets:h-1')
      // The Chat going idle on some turn of its own says nothing of a review running apart.
      await f.emit('agent/status', { agent: f.chat, status: 'idle' })
      expect(f.pane.frame('s').state.review?.status).toBe('reviewing')
      expect(await f.report(child.id, 'flagged', '本周工时少于 30 小时')).toContain('已回报')
      expect(f.pane.frame('s').state.review).toMatchObject({ status: 'flagged', message: '本周工时少于 30 小时' })
      expect(() => f.reviews.assertPassed('timesheet_header', 'h-1', 's')).toThrow(/少于 30 小时/)
      // The run ends after its verdict: the verdict stands, and the session is no longer anyone's stand-in.
      child.end('已回报。')
      await until(() => !f.reviews.owns(child.id))
      expect(f.pane.frame('s').state.review?.status).toBe('flagged')
      expect(f.pane.session(child.id)).toBeUndefined()
    } finally {
      await f.close()
    }
  })

  it('points at a draft this client keeps by what the page shows, not by a number ORYH has never seen', async () => {
    const f = await setup()
    try {
      await f.reviews.start('s', {
        objectType: 'expense_claim',
        documentId: 'draft-1',
        label: '费用申请',
        read: '先用 oryh_current_page 读取页面上的实际内容',
        reference: '页面上打开的这一张，以页面上的内容为准',
      })
      const prompt = f.children[0]!.prompt
      expect(prompt).toContain('核对这张待提交的费用申请（页面上打开的这一张，以页面上的内容为准；')
      // Its id here is the draft's: asked for by it, ORYH answers that there is no such claim.
      expect(prompt).not.toContain('draft-1')
    } finally {
      await f.close()
    }
  })

  it("says why, in the run's own last words, when it ends without a verdict", async () => {
    const f = await setup()
    try {
      await f.reviews.start('s', request)
      f.children[0]!.end('没有找到适用于工时单的业务规则。')
      await until(() => f.pane.frame('s').state.review?.status === 'unavailable')
      expect(f.pane.frame('s').state.review?.message).toBe('没有找到适用于工时单的业务规则。')
      expect(() => f.reviews.assertPassed('timesheet_header', 'h-1', 's')).toThrow(/未经/)
      // A verdict that arrives after that is about a review that is over.
      expect(await f.report(f.children[0]!.id, 'passed')).toMatch(/没有待回报|已结束/)
    } finally {
      await f.close()
    }
  })

  it('stops when the page moves on, and a new review replaces one still running', async () => {
    const f = await setup()
    try {
      await f.reviews.start('s', request)
      await f.reviews.start('s', { ...request, documentId: 'h-2' })
      expect(f.children[0]!.cancelled).toBe(true)
      expect(f.pane.frame('s').state.review).toMatchObject({ documentId: 'h-2', status: 'reviewing' })
      // The first run's end is not the second's failure.
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(f.pane.frame('s').state.review?.status).toBe('reviewing')
      f.reviews.clear('s')
      expect(f.children[1]!.cancelled).toBe(true)
      expect(f.pane.frame('s').state.review).toBeUndefined()
    } finally {
      await f.close()
    }
  })

  it('cancels a review while activation publication is pending without falling back to Chat', async () => {
    const f = await setup()
    const release = Promise.withResolvers<void>()
    const start = f.subagents.startActivation.getMockImplementation()!
    f.subagents.startActivation.mockImplementation(async spec => {
      await release.promise
      return start(spec)
    })
    try {
      const starting = f.reviews.start('s', request)
      await until(() => f.started.length === 0 && f.subagents.startActivation.mock.calls.length === 1)
      f.reviews.clear('s')
      release.resolve()
      await starting
      expect(f.said).toEqual([])
      expect(f.children).toEqual([])
      expect(f.reviews.state('s')).toBeUndefined()
    } finally {
      release.resolve()
      await f.close()
    }
  })

  it('disposes a published activation on timeout and when its parent closes', async () => {
    const f = await setup()
    try {
      vi.useFakeTimers()
      await f.reviews.start('s', request)
      await vi.advanceTimersByTimeAsync(300_001)
      expect(f.reviews.state('s')?.message).toContain('超时')
      vi.useRealTimers()
      await f.reviews.start('s', { ...request, documentId: 'h-2' })
      await f.emit('agent/disposed', { agent: f.chat })
      expect(f.children[0]!.cancelled).toBe(true)
      await until(() => !f.reviews.owns(f.children[0]!.id))
      expect(f.children[1]!.cancelled).toBe(true)
      expect(f.chatLog).toHaveLength(2)
      expect(f.said).toEqual([])
    } finally {
      vi.useRealTimers()
      f.reviews.clear('s')
      await f.close()
    }
  })

  it('asks the Chat itself, as before, where no session can be run apart', async () => {
    for (const options of [{ apart: false }, { broken: true }]) {
      const f = await setup(options)
      try {
        await f.reviews.start('s', request)
        expect(f.children).toEqual([])
        expect(f.said).toHaveLength(1)
        expect(f.said[0]).toContain('（提交动作触发）')
        expect(f.pane.frame('s').state.review).toMatchObject({ documentId: 'h-1', status: 'queued' })
        await f.report('s', 'passed')
        expect(() => f.reviews.assertPassed('timesheet_header', 'h-1', 's')).not.toThrow()
      } finally {
        await f.close()
      }
    }
  })
})
