/** Expense claims as a Harness Host plugin: the service with its submit gate, and its Remote. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { EncryptedExpenseStore } from '@oryh/ai-client-expenses'
import { EXPENSE_OBJECT_TYPE } from '@oryh/ai-client-expenses/contracts'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type {} from '@oryh/dsh-connection'
import type {} from '@oryh/dsh-pane'
import { ExpensesRemote } from './remote.js'

export { ExpensesRemote } from './remote.js'

export const name = 'oryh-expenses'
export const inject = ['typert', 'oryhHost', 'oryhData', 'oryhWorkflows', 'oryhPane', 'oryhReview']

export function apply(ctx: Context): void {
  const data = ctx.oryhData
  const store = new EncryptedExpenseStore(join(data.directory, 'expenses'), data.storeKey?.('expenses'))
  const service = ctx.oryhHost.createExpenseRemote(store)
  service.setWorkflowLookup((id, objectType) => ctx.oryhWorkflows.governed(id, objectType))
  service.setSubmitGate((objectType, documentId, sessionId) =>
    ctx.oryhReview.assertPassed(objectType, documentId, sessionId),
  )
  ctx.provide('oryhExpenses', service)
  /**
   * `expense_claim` carries a workflow definition just like `timesheet_header`, so its submit button
   * needs the same gate (docs/22). The agent reads the draft through `oryh_current_page`, which
   * already carries the editor's fields, so no expense-specific tool is required.
   */
  ctx.provide('oryhExpenseReview', (sessionId: string, draftId: string) => {
    const session = ctx.oryhPane.session(sessionId)
    if (!session) throw new OryhClientError('请先在 Chat 中选择会话并等待已关联。', 'request-failed')
    if (session.page !== 'my-expense-claims') throw new OryhClientError('当前不是费用申请页面。', 'request-failed')
    ctx.oryhReview.start(sessionId, {
      objectType: EXPENSE_OBJECT_TYPE,
      documentId: draftId,
      label: '费用申请',
      read: '先用 oryh_current_page 读取页面上的实际内容',
    })
  })
  ctx.effect(
    () => ctx.oryhPane.contribute({ name, resources: { 'expense-claims': 'my-expense-claims' } }),
    'oryh expenses contribution',
  )
  ctx.plugin(ExpensesRemote)
}
