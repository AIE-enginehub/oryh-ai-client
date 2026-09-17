/** My todos as a page plugin: one menu entry, one page in the workbench, over the `oryhTodos` namespace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@oryh/dsh-client-frame/client'
import { TYPERT_REMOTE } from '@oryh/dsh-todos/remote'
import { IconChecklist } from '@tabler/icons-react'
import { createTodosApi, TodosApiContext } from './api.js'
import { TodoPage } from './todo-page.js'

export const inject = ['slots', 'remote', 'locale', 'oryhClientPages']

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryhTodos'], ctx => {
    const api = createTodosApi(ctx.remote)
    const t = ctx.locale.bind('oryh')
    ctx.effect(
      () =>
        ctx.oryhClientPages.register({
          page: 'my-open-todos',
          order: 10,
          icon: IconChecklist,
          label: () => t('text8'),
        }),
      'oryh todos menu',
    )
    ctx.slots.inject('oryh.page', () =>
      ctx.slots.register({ name: 'oryh.page', key: 'my-open-todos' }, props => (
        <TodosApiContext.Provider value={api}>
          <TodoPage {...props} />
        </TodosApiContext.Provider>
      )),
    )
  })
}
