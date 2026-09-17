/**
 * ORYH's own name for this document, which is what a workflow definition is keyed by.
 *
 * It lives in contracts, not in the service: the page needs it to match a review against the
 * document it is confirming, and the service is Node-only.
 */
export const EXPENSE_OBJECT_TYPE = 'expense_claim'

import { OryhClientError } from '@oryh/ai-client-foundation'

/** Editable, model-independent expense fields; identity and lifecycle are Host-owned. */
export interface ExpenseFields {
  title: string
  claimDate: string
  currency: string
  items: ExpenseLine[]
}
export interface ExpenseLine {
  expenseDate: string
  category: string
  amount: string
  merchant: string
  invoiceNumber: string
  notes: string
  attachment?: ExpenseAttachment
}
export interface ExpenseAttachment {
  id: string
  filename: string
  sha256: string
}
export type ExpenseState =
  | 'editing'
  | 'review-create'
  | 'creating'
  | 'created'
  | 'review-submit'
  | 'submitting'
  | 'submitted'
  | 'unknown-create'
  | 'unknown-submit'
export interface ExpenseDraft {
  id: string
  revision: number
  fields: ExpenseFields
  state: ExpenseState
  updatedAt: string
  claimId?: string
  serverStatus?: string
  submittedAt?: string | null
  confirmation?: { token: string; expiresAt: string; action: 'create' | 'submit' } | undefined
  message?: string | undefined
}
/** Methods shared by the native controller and browser; confirmation is a user action, never an AI tool. */
export interface OryhExpenseRemote {
  expenseList(connectionId: string): Promise<ExpenseDraft[]>
  expenseOptions(connectionId: string): Promise<{ categories: { name: string; title: string }[] }>
  expenseSave(
    connectionId: string,
    input: { id?: string; revision?: number; fields: ExpenseFields },
  ): Promise<ExpenseDraft>
  expensePrepare(connectionId: string, id: string, revision: number): Promise<ExpenseDraft>
  expenseConfirm(
    connectionId: string,
    id: string,
    revision: number,
    token: string,
    sessionId?: string,
  ): Promise<ExpenseDraft>
  expenseReconcile(connectionId: string, id: string, revision: number): Promise<ExpenseDraft>
  expenseUpload(
    connectionId: string,
    input: { filename: string; contentType: string; contentBase64: string },
  ): Promise<ExpenseAttachment>
  expenseDelete(connectionId: string, id: string, revision: number): Promise<void>
}

export function expenseError(message: string): OryhClientError {
  return new OryhClientError(message, 'expense-conflict', 409)
}
// This helper was borrowed by the timesheets, projects and todo domains before they were
// extracted, which is why a malformed response in any of them reported an expense conflict.
// Each domain now has its own; this one stays here, where the error is actually correct.
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw expenseError('费用数据无效。')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && value.trim().length === 0))
    throw expenseError('费用字段为空或超过长度限制。')
  return value.trim()
}
function date(value: unknown): string {
  const input = text(value, 10, true)
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input) ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString().slice(0, 10) !== input
  )
    throw expenseError('请输入有效日期。')
  return input
}
/** Parse at the Host boundary; amounts remain decimal strings until the ORYH request. */
export function parseExpenseFields(value: unknown, complete = true): ExpenseFields {
  const data = object(value)
  if (!Array.isArray(data.items) || data.items.length === 0 || data.items.length > 100)
    throw expenseError('费用明细必须为 1–100 项。')
  const currency = text(data.currency, 3, complete).toUpperCase()
  if ((complete || currency !== '') && !/^[A-Z]{3}$/u.test(currency)) throw expenseError('请输入三位币种代码。')
  return {
    title: text(data.title, 200, complete),
    claimDate: !complete && data.claimDate === '' ? '' : date(data.claimDate),
    currency,
    items: data.items.map(raw => {
      const line = object(raw)
      const amount = text(line.amount, 12, complete)
      if (
        (complete || amount !== '') &&
        (!/^\d{1,7}(\.\d{1,2})?$/u.test(amount) || Number(amount) <= 0 || Number(amount) > 9_999_999.99)
      )
        throw expenseError('金额必须大于零、最多两位小数且不超过 9,999,999.99。')
      let attachment: ExpenseAttachment | undefined
      if (line.attachment !== undefined) {
        const item = object(line.attachment)
        attachment = {
          id: text(item.id, 100, true),
          filename: text(item.filename, 255, true),
          sha256: text(item.sha256, 64, true),
        }
      }
      return {
        expenseDate: !complete && line.expenseDate === '' ? '' : date(line.expenseDate),
        category: text(line.category, 100, complete),
        amount: amount === '' ? '' : Number(amount).toFixed(2),
        merchant: text(line.merchant, 200),
        invoiceNumber: text(line.invoiceNumber, 100),
        notes: text(line.notes, 2000),
        ...(attachment === undefined ? {} : { attachment }),
      }
    }),
  }
}
