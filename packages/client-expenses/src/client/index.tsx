/** Expense claims as a page plugin: one menu entry, one page, over the `oryhExpenses` namespace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@oryh/dsh-client-frame/client'
import { TYPERT_REMOTE } from '@oryh/dsh-expenses/remote'
import { IconReceipt } from '@tabler/icons-react'
import { createExpensesApi, ExpensesApiContext } from './api.js'
import { ExpensePage } from './expense-page.js'

export const inject = ['slots', 'remote', 'locale', 'oryhClientPages']

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryhExpenses'], ctx => {
    const api = createExpensesApi(ctx.remote)
    const t = ctx.locale.bind('oryh')
    ctx.effect(
      () =>
        ctx.oryhClientPages.register({
          page: 'my-expense-claims',
          order: 20,
          icon: IconReceipt,
          label: () => t('text10'),
        }),
      'oryh expenses menu',
    )
    ctx.slots.inject('oryh.page', () =>
      ctx.slots.register({ name: 'oryh.page', key: 'my-expense-claims' }, props => (
        <ExpensesApiContext.Provider value={api}>
          <ExpensePage {...props} />
        </ExpensesApiContext.Provider>
      )),
    )
  })
}
