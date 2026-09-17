import type { Context } from '@deepseek-ai/cordis'
import { PaneService, SubmitReview, UserViewRegistry } from '@oryh/dsh-pane'
import { connectionId, fakeContext, fakeController, paneSyncer, tempDirectory, vi } from '@oryh/dsh-pane/testing'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

/** The plugin over a fake Host: the expense service is what the Host builds, the gate what the plugin installs. */
async function setup() {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const { controller } = fakeController()
  const pane = new PaneService(harness.ctx, controller, temp.directory, new UserViewRegistry(harness.ctx))
  const reviews = new SubmitReview(harness.ctx, pane)
  reviews.install()
  const service = { setWorkflowLookup: vi.fn(), setSubmitGate: vi.fn() }
  const governed = vi.fn(async () => true)
  Object.assign(harness.ctx, {
    oryhHost: { createExpenseRemote: vi.fn(() => service) },
    oryhData: { directory: temp.directory, capabilities: { shell: true, writes: true } },
    oryhWorkflows: { governed },
    oryhPane: pane,
    oryhReview: reviews,
  })
  plugin.apply(harness.ctx as Context)
  await pane.bind({ sessionId: 's', connectionId })
  return { ...harness, pane, reviews, service, governed, page: paneSyncer(pane), close: temp.close }
}

describe('the expenses plugin', () => {
  it('builds the service over the data directory and wires the shared submit gate', async () => {
    const f = await setup()
    try {
      expect(f.ctx.oryhExpenses).toBe(f.service)
      expect(f.service.setWorkflowLookup).toHaveBeenCalled()
      expect(f.service.setSubmitGate).toHaveBeenCalled()
      const lookup = f.service.setWorkflowLookup.mock.calls[0]![0] as (id: string, type: string) => Promise<boolean>
      expect(await lookup('c', 'expense_claim')).toBe(true)
      expect(f.governed).toHaveBeenCalledWith('c', 'expense_claim')
      const gate = f.service.setSubmitGate.mock.calls[0]![0] as (type: string, id: string, session?: string) => void
      // Nothing reviewed yet: the gate is the review's own verdict.
      expect(() => gate('expense_claim', 'd', 's')).toThrow()
      expect(f.pane.contributions().some(c => c.resources?.['expense-claims'] === 'my-expense-claims')).toBe(true)
      expect(f.plugins).toEqual([plugin.ExpensesRemote])
    } finally {
      await f.close()
    }
  })
  it('starts a pre-submit review only for the expense page of a bound session', async () => {
    const f = await setup()
    try {
      const start = f.ctx.oryhExpenseReview
      expect(() => start('other', 'd')).toThrow(/会话/)
      f.page.sync('list-projects')
      expect(() => start('s', 'd')).toThrow(/费用申请页面/)
      f.page.sync('my-expense-claims')
      start('s', 'd')
      expect(f.reviews.state('s')).toMatchObject({ objectType: 'expense_claim', documentId: 'd', label: '费用申请' })
    } finally {
      await f.close()
    }
  })
})
