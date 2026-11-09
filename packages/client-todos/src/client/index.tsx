/** My todos as a page plugin: one menu entry, one page in the workbench, over the `oryhTodos` namespace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@oryh/dsh-client-frame/client'
import { TYPERT_REMOTE } from '@oryh/dsh-todos/remote'
import { IconChecklist } from '@tabler/icons-react'
import { createTodosApi } from './api.js'
import { english } from './en.js'
import { TodoPage } from './todo-page.js'
import { type WordKey, words } from './words.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    oryhTodos: WordKey
  }
}

export const inject = ['slots', 'remote', 'locale', 'oryhClientPages']

export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('oryhTodos', { zh: words, en: english }), 'oryh todos locale')
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryhTodos'], ctx => {
    const api = createTodosApi(ctx.remote)
    const frameT = ctx.locale.bind('oryh')
    ctx.effect(
      () =>
        ctx.oryhClientPages.register({
          page: 'my-open-todos',
          order: 10,
          group: 'work',
          icon: IconChecklist,
          label: () => frameT('text8'),
        }),
      'oryh todos menu',
    )
    ctx.slots.inject('oryh.page', () =>
      // The entry's props are what the frame's slot handed this page; its components take them as `face`.
      ctx.slots.register({ name: 'oryh.page', key: 'my-open-todos', locale: 'oryhTodos' }, props => (
        <TodoPage face={props} api={api} t={props.t} />
      )),
    )
  })
}
