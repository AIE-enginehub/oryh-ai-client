import type { OryhTimesheetRemote, TimesheetFields } from '@oryh/ai-client-timesheets'
import { PaneService, SubmitReview, UserViewRegistry } from '@oryh/dsh-pane'
import {
  connectionId,
  fakeContext,
  fakeController,
  paneSyncer,
  pending,
  tempDirectory,
  until,
} from '@oryh/dsh-pane/testing'
import type { FormCommand, NavigationCommand, PaneContext } from '@oryh/dsh-pane/types'
import { describe, expect, it, vi } from 'vitest'
import { TimesheetChat } from '../src/timesheet-chat.js'

/** The page's shape: what the form syncs back and what a stored proposal must look like. */
const form: TimesheetFields = {
  period_start: '2026-09-09',
  period_end: '2026-09-09',
  source_report_text: '开发',
  entries: [{ work_date: '2026-09-09', hours: 8, work_type: 'normal', project_id: 'p', task: '开发', notes: '' }],
}
/** The tool's shape: the page form plus the name assertion the tool must make about each id. */
const proposed = { ...form, entries: form.entries.map(entry => ({ ...entry, project_name: '项目' })) }
const projects = [
  { id: 'p', name: '项目' },
  { id: 'q', name: '另一个项目' },
]
const header = {
  id: 'h',
  employee_id: 'e',
  period_start: '2026-09-09',
  period_end: '2026-09-09',
  status: 'draft',
  source_report_text: '',
}

async function setup() {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const prepare = vi.fn(),
    confirm = vi.fn()
  const api = {
    timesheetList: async () => [header],
    timesheetQueue: async () => [{ id: 't', entity_id: 'h', title: '审批', description: '' }],
    timesheetOptions: async () => ({
      workTypes: [{ name: 'normal', title: '正常工时' }],
      projects,
      editableStates: ['draft'],
      submitStates: ['draft'],
      requirements: [],
    }),
    timesheetDetail: async () => ({ header, entries: [{ ...form.entries[0], id: 'line' }], approval_records: [] }),
    timesheetPrepare: prepare,
    timesheetConfirm: confirm,
  } as unknown as OryhTimesheetRemote
  const pane = new PaneService(
    harness.ctx,
    fakeController().controller,
    temp.directory,
    new UserViewRegistry(harness.ctx),
  )
  // The review is shared across every document kind ORYH governs with a workflow definition, so the
  // fixture builds the real one rather than a stub: its tool and listeners are what is under test.
  const reviews = new SubmitReview(harness.ctx, pane)
  reviews.install()
  const chat = new TimesheetChat(harness.ctx, api, pane, reviews)
  chat.install()
  await pane.bind({ sessionId: 's', connectionId })
  const page = paneSyncer(pane)
  const showing = (
    fields: TimesheetFields | undefined,
    extra: Partial<PaneContext['timesheet']> = {},
    manager = false,
  ): PaneContext => ({
    key: manager ? 'timesheet-approvals:list' : 'timesheets:new',
    title: '',
    detail: '',
    scope: '',
    timesheet: { manager, ...(fields ? { fields } : {}), ...extra },
  })
  const exec = { agent: { id: 's' }, signal: new AbortController().signal }
  return {
    ...harness,
    chat,
    reviews,
    api,
    pane,
    page,
    prepare,
    confirm,
    exec,
    showing,
    /** Sync the person's timesheet page with this unsaved form. */
    form: (fields: TimesheetFields | undefined = form, extra: Partial<PaneContext['timesheet']> = {}) =>
      page.sync('timesheets', showing(fields, extra)),
    pending: () => pane.queue.peek('s', 'form') as FormCommand | undefined,
    /** Simulate the driver claiming the queued request, then the status transition it raises. */
    claimRequest: () => {
      harness.agent.inbox.nextTurn.length = 0
      harness.emit('agent/status', { agent: harness.agent, status: 'running' })
    },
    close: temp.close,
  }
}

const fill = (f: Awaited<ReturnType<typeof setup>>, revision: number, action: unknown) =>
  f.chat.fill('s', revision, action, new AbortController().signal)

describe('timesheet suggestions', () => {
  it('reads user fields and stages a proposal without prepare, confirm or tokens', async () => {
    const f = await setup()
    try {
      const revision = f.form()
      expect((await f.chat.read('s')).form).toEqual(form)
      const filling = fill(f, revision, { kind: 'create', fields: proposed })
      await until(() => f.pending() !== undefined)
      const p = f.pending()!.payload
      // The stored proposal is page-shaped: the name assertion is for validation, never for the form.
      expect(p.kind === 'timesheet' && p.action.fields).toEqual(form)
      expect(JSON.stringify(p)).not.toContain('project_name')
      expect(JSON.stringify(p)).not.toContain('token')
      f.page.ack('form', 'timesheets', f.showing(form))
      expect(JSON.parse(await filling).message).toContain('已更新')
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  it('accepts incremental form filling without treating it as a savable record', async () => {
    const f = await setup()
    try {
      const revision = f.form()
      const partial = {
        ...proposed,
        entries: [{ ...proposed.entries[0]!, hours: 0, work_type: '', task: '先填写工作内容' }],
      }
      const filling = fill(f, revision, { kind: 'create', fields: partial })
      await until(() => f.pending() !== undefined)
      const p = f.pending()!.payload
      expect(p.kind === 'timesheet' && p.action.fields?.entries[0]?.hours).toBe(0)
      f.page.ack(
        'form',
        'timesheets',
        f.showing({ ...form, entries: [{ ...form.entries[0]!, hours: 0, work_type: '', task: '先填写工作内容' }] }),
      )
      await filling
      expect(f.prepare).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  it('rejects stale revisions and pages that are not a timesheet', async () => {
    const f = await setup()
    try {
      f.form()
      await expect(fill(f, 0, { kind: 'create', fields: proposed })).rejects.toThrow(/版本/)
      f.page.sync('list-projects')
      await expect(f.chat.read('s')).rejects.toThrow(/工时菜单/)
    } finally {
      await f.close()
    }
  })
  it('rejects unknown targets, guessed projects, invalid hours and approvals staged on the page', async () => {
    const f = await setup()
    try {
      const revision = f.form()
      await expect(f.chat.read('s', 'foreign')).rejects.toThrow(/不在/)
      await expect(
        fill(f, revision, {
          kind: 'create',
          fields: { ...proposed, entries: [{ ...proposed.entries[0], hours: 25 }] },
        }),
      ).rejects.toThrow(/24/)
      await expect(
        fill(f, revision, {
          kind: 'create',
          fields: { ...proposed, entries: [{ ...proposed.entries[0], project_id: 'foreign' }] },
        }),
      ).rejects.toThrow(/项目/)
      await expect(
        fill(f, revision, { kind: 'approve', headerId: 'h', todoId: 't', decision: 'approved', comment: '同意' }),
      ).rejects.toThrow(/skill/)
    } finally {
      await f.close()
    }
  })
  it('rejects a project whose asserted name does not match the id it resolved to', async () => {
    // The observed defect: a well-formed id that is not the project the user asked for. An id-only
    // check cannot see it, so the tool must state the name as a second, independent claim.
    const f = await setup()
    try {
      const revision = f.form()
      await expect(
        fill(f, revision, {
          kind: 'create',
          fields: { ...proposed, entries: [{ ...proposed.entries[0], project_id: 'q' }] },
        }),
      ).rejects.toThrow(/不一致.*另一个项目.*项目/s)
      expect(f.pending()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('requires the id and the name to be given together or both left empty', async () => {
    const f = await setup()
    try {
      const revision = f.form()
      await expect(
        fill(f, revision, {
          kind: 'create',
          fields: { ...proposed, entries: [{ ...proposed.entries[0], project_id: '' }] },
        }),
      ).rejects.toThrow(/没有给出项目编号/)
      await expect(
        fill(f, revision, {
          kind: 'create',
          fields: { ...proposed, entries: [{ ...proposed.entries[0], project_name: '' }] },
        }),
      ).rejects.toThrow(/请同时给出项目名称/)
      // Both empty is the documented way to record no project at all.
      const filling = fill(f, revision, {
        kind: 'create',
        fields: { ...proposed, entries: [{ ...proposed.entries[0], project_id: '', project_name: '' }] },
      })
      await until(() => f.pending() !== undefined)
      const p = f.pending()!.payload
      expect(p.kind === 'timesheet' && p.action.fields?.entries[0]?.project_id).toBe('')
      f.page.ack('form', 'timesheets', f.showing({ ...form, entries: [{ ...form.entries[0]!, project_id: '' }] }))
      await filling
    } finally {
      await f.close()
    }
  })
  it('flags duplicate project names so the model has to ask which one', async () => {
    const f = await setup()
    try {
      f.form()
      f.api.timesheetOptions = async () => ({
        workTypes: [{ name: 'normal', title: '正常工时' }],
        projects: [
          { id: 'p', name: '项目' },
          { id: 'q', name: '项目' },
        ],
        editableStates: ['draft'],
        submitStates: ['draft'],
        requirements: [],
      })
      const read = await f.chat.read('s')
      expect(read.ambiguousProjects).toEqual(['项目'])
      // Only the duplicated name is called out; a tenant can have many unique projects alongside it.
      expect(read.notice).toContain('“项目”')
      expect(read.notice).toContain('不必反问')
    } finally {
      await f.close()
    }
  })
  it('reports the page content in the receipt rather than echoing the requested fields', async () => {
    const f = await setup()
    try {
      const revision = f.form()
      const call = f
        .tool('oryh_timesheet_propose')
        .execute({ revision, action: { kind: 'create', fields: proposed } }, f.exec)
      await until(() => f.pending() !== undefined)
      // The page ends up holding a different project and fewer hours than were requested.
      f.page.ack(
        'form',
        'timesheets',
        f.showing({ ...form, entries: [{ ...form.entries[0]!, project_id: 'q', hours: 3 }] }),
      )
      const receipt = JSON.parse(await call)
      expect(receipt.applied.entries[0].project_id).toBe('q')
      expect(receipt.applied.entries[0].project_name).toBe('另一个项目')
      expect(receipt.applied.total_hours).toBe(3)
      expect(receipt.message).toContain('其他修改')
    } finally {
      await f.close()
    }
  })
  it('names the applied project and totals when the page matches the request', async () => {
    const f = await setup()
    try {
      const revision = f.form()
      const call = f
        .tool('oryh_timesheet_propose')
        .execute({ revision, action: { kind: 'create', fields: proposed } }, f.exec)
      await until(() => f.pending() !== undefined)
      f.page.ack('form', 'timesheets', f.showing(form))
      const receipt = JSON.parse(await call)
      expect(receipt.message).toContain('已更新')
      expect(receipt.applied.entries[0].project_name).toBe('项目')
      expect(receipt.applied.total_hours).toBe(8)
      expect(receipt.applied.daily_hours).toEqual([{ work_date: '2026-09-09', hours: 8 }])
    } finally {
      await f.close()
    }
  })
  it('withdraws a fill the page never applied, and one the page left', async () => {
    const f = await setup()
    try {
      const revision = f.form()
      const leaving = fill(f, revision, { kind: 'create', fields: proposed })
      await until(() => f.pending() !== undefined)
      f.page.sync('list-projects')
      await expect(leaving).rejects.toThrow(/已离开/)
      expect(f.pending()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('asks the agent to review a submission through its inbox, without starting a competing turn', async () => {
    const f = await setup()
    try {
      f.form()
      f.agent.status = 'running'
      await f.chat.reviewStart('s', 'h')
      // followup queues behind a running turn and still wakes an idle one; append does neither.
      expect(f.agent.inbox.nextTurn).toHaveLength(1)
      // The request is still pending in the inbox, so the page shows it queued rather than running.
      expect(f.reviews.state('s')).toEqual({
        objectType: 'timesheet_header',
        documentId: 'h',
        label: '工时单',
        status: 'queued',
      })
      expect(f.pane.frame('s').state.review?.status).toBe('queued')
    } finally {
      await f.close()
    }
  })
  it('settles a review whose turn died, reporting why', async () => {
    const f = await setup()
    try {
      f.form()
      await f.chat.reviewStart('s', 'h')
      f.claimRequest()
      expect(f.reviews.state('s')?.status).toBe('reviewing')
      // The turn fails (a model quota error here) and then the agent goes idle with nothing reported.
      f.emit('agent/error', { agent: f.agent, error: new Error('Allocated quota exceeded') })
      f.emit('agent/status', { agent: f.agent, status: 'idle' })
      expect(f.reviews.state('s')).toEqual({
        objectType: 'timesheet_header',
        documentId: 'h',
        label: '工时单',
        status: 'unavailable',
        message: 'Allocated quota exceeded',
      })
      // A verdict arriving late for a settled review is ignored rather than reviving it.
      expect(await f.tool('oryh_review_result').execute({ verdict: 'passed', message: '' }, f.exec)).toContain('已结束')
      expect(f.reviews.state('s')?.status).toBe('unavailable')
      // And an unavailable review must not open the submit gate.
      expect(() => f.reviews.assertPassed('timesheet_header', 'h', 's')).toThrow(/未经/)
    } finally {
      await f.close()
    }
  })
  it('lets only a passed verdict through the submit gate', async () => {
    const f = await setup()
    try {
      f.form()
      // No review at all is not a free pass: it is the state anyone would reach by closing the session.
      expect(() => f.reviews.assertPassed('timesheet_header', 'h', 's')).toThrow(/未经/)
      await f.chat.reviewStart('s', 'h')
      expect(() => f.reviews.assertPassed('timesheet_header', 'h', 's')).toThrow(/尚未完成/)
      await f
        .tool('oryh_review_result')
        .execute({ verdict: 'flagged', message: '本周合计 24 小时，少于 30 小时' }, f.exec)
      expect(() => f.reviews.assertPassed('timesheet_header', 'h', 's')).toThrow(/少于 30 小时/)
      // Nothing about a flagged verdict may be worked around by dropping the session id either.
      expect(() => f.reviews.assertPassed('timesheet_header', 'h', undefined)).toThrow(/未经/)
      f.reviews.clear('s')
      await f.chat.reviewStart('s', 'h')
      await f.tool('oryh_review_result').execute({ verdict: 'passed', message: '' }, f.exec)
      expect(() => f.reviews.assertPassed('timesheet_header', 'h', 's')).not.toThrow()
      // A verdict about a different timesheet must not clear this one.
      expect(() => f.reviews.assertPassed('timesheet_header', 'other', 's')).toThrow(/未经/)
    } finally {
      await f.close()
    }
  })
  it('moves from queued to reviewing when the agent claims the request', async () => {
    const f = await setup()
    try {
      f.form()
      await f.chat.reviewStart('s', 'h')
      expect(f.reviews.state('s')?.status).toBe('queued')
      // The review's own first step is what marks it running: agent/status fires before the inbox
      // drains, so the read tool is the dependable signal.
      await f.tool('oryh_timesheet_read').execute({ headerId: '' }, f.exec)
      expect(f.reviews.state('s')?.status).toBe('reviewing')
      await f.tool('oryh_review_result').execute({ verdict: 'passed', message: '' }, f.exec)
      // A settled verdict must not be dragged back by a later read.
      await f.tool('oryh_timesheet_read').execute({ headerId: '' }, f.exec)
      expect(f.reviews.state('s')?.status).toBe('passed')
    } finally {
      await f.close()
    }
  })
  it('publishes the agent verdict and ignores one that arrives for no live review', async () => {
    const f = await setup()
    try {
      f.form()
      const report = f.tool('oryh_review_result')
      // No review running: a stray verdict must not appear against the next submission.
      expect(await report.execute({ verdict: 'passed', message: '' }, f.exec)).toContain('没有待回报')
      expect(f.reviews.state('s')).toBeUndefined()
      await f.chat.reviewStart('s', 'h')
      await report.execute({ verdict: 'flagged', message: '本周合计 36 小时，少于要求的 40 小时。' }, f.exec)
      expect(f.reviews.state('s')?.status).toBe('flagged')
      expect(f.reviews.state('s')?.message).toBe('本周合计 36 小时，少于要求的 40 小时。')
      // A second verdict for a settled review is late, not a correction.
      expect(await report.execute({ verdict: 'passed', message: '' }, f.exec)).toContain('已结束')
      expect(f.reviews.state('s')?.status).toBe('flagged')
    } finally {
      await f.close()
    }
  })
  it('leaves submitting and approving to the agent in the conversation instead of staging them on the page', async () => {
    // ADR-0010: the agent writes through ORYH's skills and confirms in the conversation, so nothing
    // here may route a submit or an approval to the page's confirmation dialog.
    const f = await setup()
    try {
      const revision = f.form()
      await expect(fill(f, revision, { kind: 'submit', headerId: 'h' })).rejects.toThrow(/skill/)
      const approvals = f.page.sync('timesheet-approvals', f.showing(undefined, {}, true))
      await expect(
        fill(f, approvals, { kind: 'approve', headerId: 'h', todoId: 't', decision: 'approved', comment: '同意' }),
      ).rejects.toThrow(/skill/)
      // The approval page has no form to fill at all.
      await expect(fill(f, approvals, { kind: 'create', fields: proposed })).rejects.toThrow(/审批页面没有可填写的表单/)
      expect(f.pending()).toBeUndefined()
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  it('discards in-flight reads when the user leaves the page', async () => {
    const f = await setup()
    try {
      f.form()
      let release!: () => void
      const list = f.api.timesheetList
      f.api.timesheetList = async id => {
        await new Promise<void>(r => {
          release = r
        })
        return list(id)
      }
      const reading = f.chat.read('s')
      await new Promise(r => setTimeout(r, 0))
      f.page.sync('list-projects')
      release()
      await expect(reading).rejects.toThrow(/离开|改变/)
    } finally {
      await f.close()
    }
  })
})

describe('aggregate edit suggestions', () => {
  it('preserves existing ids and only stages a draft, refusing duplicate or foreign ids', async () => {
    const f = await setup()
    try {
      f.api.timesheetDetail = async () => ({
        canEdit: true,
        header,
        entries: [{ ...form.entries[0]!, id: 'line', projectName: '项目', client: '' }],
        approval_records: [],
      })
      const revision = f.form(form, { headerId: 'h' })
      const fields = {
        ...proposed,
        entries: [
          { ...proposed.entries[0]!, id: 'line', hours: 6 },
          { ...proposed.entries[0]!, hours: 2 },
        ],
      }
      const filling = fill(f, revision, { kind: 'update', headerId: 'h', fields })
      await until(() => f.pending() !== undefined)
      const p = f.pending()!.payload
      expect(p.kind === 'timesheet' && p.action.fields?.entries.map(l => l.id)).toEqual(['line', undefined])
      expect(f.prepare).not.toHaveBeenCalled()
      f.page.ack(
        'form',
        'timesheets',
        f.showing({ ...form, entries: fields.entries.map(({ project_name: _n, ...l }) => l) }, { headerId: 'h' }),
      )
      await filling
      const again = f.pane.session('s')!.revision
      await expect(
        fill(f, again, {
          kind: 'update',
          headerId: 'h',
          fields: { ...fields, entries: [{ ...fields.entries[0], id: 'foreign' }] },
        }),
      ).rejects.toThrow(/编号/)
      await expect(
        fill(f, again, {
          kind: 'update',
          headerId: 'h',
          fields: { ...fields, entries: [fields.entries[0], fields.entries[0]] },
        }),
      ).rejects.toThrow(/编号/)
    } finally {
      await f.close()
    }
  })
})

// ── Opening a timesheet from Chat ─────────────────────────────────────────────────────────────────

const blankForm = { period_start: '', period_end: '', source_report_text: '', entries: [] }

/** A chat over whatever the test says the timesheet API answers, before any page has synced. */
async function opener(api: Partial<OryhTimesheetRemote> = {}) {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const { connection, controller } = fakeController()
  const pane = new PaneService(harness.ctx, controller, temp.directory, new UserViewRegistry(harness.ctx))
  const reviews = new SubmitReview(harness.ctx, pane)
  const chat = new TimesheetChat(harness.ctx, api as OryhTimesheetRemote, pane, reviews)
  chat.install()
  await pane.bind({ sessionId: 's', connectionId })
  const open = (headerId = '', todoId = '', discard = false, signal = new AbortController().signal) =>
    chat.openTimesheet('s', signal, headerId, todoId, discard)
  return {
    ...harness,
    chat,
    pane,
    connection,
    open,
    page: paneSyncer(pane),
    navigation: () => pending(pane) as NavigationCommand | undefined,
    close: temp.close,
  }
}

describe('opening a timesheet from Chat', () => {
  it('issues one navigation command and settles on the acknowledged form', async () => {
    const f = await opener()
    try {
      const pendingOpen = f.open()
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload).toMatchObject({ target: 'timesheet', page: 'timesheets' })
      const showing = {
        key: 'timesheets:new',
        title: '',
        detail: '',
        scope: '',
        timesheet: { manager: false, fields: blankForm },
      }
      // A sync that does not acknowledge the command leaves it pending.
      f.page.sync('timesheets', showing)
      expect(f.navigation()).toBeDefined()
      f.page.ack('navigation', 'timesheets', showing)
      expect(await pendingOpen).toContain('表单已打开')
      expect(f.navigation()).toBeUndefined()
      // The pane followed the form; leaving it drops what the chat read.
      expect(f.chat.current('s')?.fields).toEqual(blankForm)
      f.page.sync('list-projects', { key: 'list-projects:list', title: '项目', detail: '', scope: '' })
      expect(f.chat.current('s')).toBeUndefined()
      await expect(f.chat.read('s')).rejects.toThrow()
    } finally {
      await f.close()
    }
  })
  it('refuses navigation when the enterprise identity changed', async () => {
    const f = await opener()
    try {
      f.connection.identity.user.employeeId = 'other'
      await expect(f.open()).rejects.toThrow(/身份/)
    } finally {
      await f.close()
    }
  })
  it('cancels pending navigation on abort', async () => {
    const f = await opener()
    try {
      const c = new AbortController()
      c.abort()
      await expect(f.open('', '', false, c.signal)).rejects.toThrow()
      expect(f.navigation()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it.each([false, true])(
    'validates the target before navigating and awaits the matching detail (manager=%s)',
    async manager => {
      const calls: unknown[] = []
      const f = await opener({
        timesheetDetail: async (...args: unknown[]) => {
          calls.push(args)
          return { header: { id: 'header' }, canEdit: !manager } as never
        },
      })
      try {
        const page = manager ? 'timesheet-approvals' : 'timesheets'
        const opening = f.open('header', manager ? 'todo' : '')
        await until(() => f.navigation() !== undefined)
        expect(calls).toEqual([[connectionId, 'header', manager ? 'todo' : undefined]])
        expect(f.navigation()?.payload).toMatchObject({ headerId: 'header', manager, page })
        // The wrong pane does not settle it: the approvals page cannot answer for the person's own list.
        f.page.ack('navigation', page, {
          key: `${page}:header`,
          title: '',
          detail: '',
          scope: '',
          timesheet: { manager: !manager, headerId: 'header' },
        })
        await new Promise(r => setTimeout(r, 0))
        expect(f.navigation()).toBeDefined()
        f.page.sync(page, {
          key: `${page}:header`,
          title: '',
          detail: '',
          scope: '',
          timesheet: { manager, headerId: 'header', ...(manager ? { todoId: 'todo' } : {}) },
        })
        expect(await opening).toContain('指定工时已在中间栏打开')
      } finally {
        await f.close()
      }
    },
  )
  it('replaces an unsaved form only when the agent saw it as it is, so a draft written in Chat gives way to the saved timesheet', async () => {
    const f = await opener({
      timesheetOptions: async () => ({
        workTypes: [],
        projects: [],
        requirements: [],
        editableStates: [],
        submitStates: [],
      }),
      timesheetList: async () => [],
      timesheetQueue: async () => [],
      timesheetDetail: async () => ({ header: { id: 'header' }, canEdit: false, entries: [] }) as never,
    })
    const draft = {
      period_start: '2026-09-14',
      period_end: '2026-09-18',
      source_report_text: '',
      entries: [{ work_date: '2026-09-14', hours: 8, work_type: 'regular', project_id: '', task: '调试', notes: '' }],
    }
    const showing = (fields: typeof draft, localEdits = '{}') => ({
      key: 'timesheets:new',
      title: '',
      detail: '',
      scope: '',
      timesheet: { manager: false, fields, localEdits },
    })
    try {
      f.page.sync('timesheets', showing(draft))
      // Never read: the agent cannot know what it would throw away.
      await expect(f.open('header', '', true)).rejects.toThrow(/被用户改动/)
      await f.chat.read('s')
      const opening = f.open('header', '', true)
      await until(() => f.navigation() !== undefined)
      expect(f.navigation()?.payload.discardForm).toBe(JSON.stringify(draft))
      f.page.ack('navigation', 'timesheets', {
        key: 'timesheets:header',
        title: '',
        detail: '',
        scope: '',
        timesheet: { manager: false, headerId: 'header' },
      })
      expect(await opening).toContain('原先的未保存表单已放弃')
      // The person changed the form, or has a line open, after the agent read it: theirs to keep.
      f.page.sync('timesheets', showing(draft))
      await f.chat.read('s')
      f.page.sync('timesheets', showing({ ...draft, source_report_text: '我改的' }))
      await expect(f.open('header', '', true)).rejects.toThrow(/被用户改动/)
      await f.chat.read('s')
      f.page.sync(
        'timesheets',
        showing({ ...draft, source_report_text: '我改的' }, JSON.stringify({ editing: { line: draft.entries[0] } })),
      )
      await expect(f.open('header', '', true)).rejects.toThrow(/正在编辑/)
    } finally {
      await f.close()
    }
  })
  it('does not publish navigation for an inaccessible record', async () => {
    const f = await opener({
      timesheetDetail: async () => {
        throw Error('没有权限')
      },
    })
    try {
      await expect(f.open('other')).rejects.toThrow('没有权限')
      expect(f.navigation()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
})
