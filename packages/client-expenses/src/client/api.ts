import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { OryhExpenseRemote } from '@oryh/ai-client-expenses'
import { connectionRequest, unwrap } from '@oryh/dsh-client-frame/client'
import type {} from '@oryh/dsh-expenses/remote'
import { createContext, useContext } from 'react'

/** The expenses namespace (`oryhExpenses`), as the page calls it. */
export interface ExpensesApi extends OryhExpenseRemote {
  /** Start the pre-submit review of a draft in the bound Chat session. */
  expenseReviewStart(sessionId: string, draftId: string): Promise<void>
}
export const ExpensesApiContext = createContext<ExpensesApi | undefined>(undefined)
export function useExpensesApi(): ExpensesApi {
  const api = useContext(ExpensesApiContext)
  if (!api) throw new Error('ORYH expenses Remote is not mounted')
  return api
}
export function createExpensesApi(remote: ClientRemote): ExpensesApi {
  const expenses = remote.oryhExpenses
  const connection = connectionRequest
  return {
    expenseList: id => unwrap(expenses.expenseList(connection(id))),
    expenseOptions: id => unwrap(expenses.expenseOptions(connection(id))),
    expenseSave: (id, input) => unwrap(expenses.expenseSave({ ...connection(id), ...input })),
    expensePrepare: (cid, id, revision) => unwrap(expenses.expensePrepare({ ...connection(cid), id, revision })),
    expenseConfirm: (cid, id, revision, token) =>
      unwrap(expenses.expenseConfirm({ ...connection(cid), id, revision, token })),
    expenseReconcile: (cid, id, revision) => unwrap(expenses.expenseReconcile({ ...connection(cid), id, revision })),
    expenseUpload: (id, input) => unwrap(expenses.expenseUpload({ ...connection(id), ...input })),
    expenseDelete: (cid, id, revision) => unwrap(expenses.expenseArchive({ ...connection(cid), id, revision })),
    expenseReviewStart: (sessionId, draftId) => unwrap(expenses.expenseReviewStart({ sessionId, draftId })),
  }
}
