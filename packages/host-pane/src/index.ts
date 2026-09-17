/**
 * The business pane bridge as a Harness Host plugin.
 *
 * One protocol joins the business pane to the Chat session: the page reports what it shows, the
 * Host publishes what the agent asks of it. Page plugins contribute their tools, rules and record
 * openers through `ctx.oryhPane.contribute()`; the agent plugin reads them.
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@oryh/dsh-connection'
import { PaneRemote } from './remote.js'
import { PaneService } from './service.js'
import { SubmitReview } from './submit-review.js'
import { installPaneTools, PANE_TOOLS } from './tools.js'
import { UserViewRegistry } from './user-views.js'

export { NAVIGATION_WITHOUT_PANE, NO_PAGE, NO_PAGE_CONTEXT } from './notices.js'
export type { PaneSession } from './registry.js'
export { PaneRemote } from './remote.js'
export { type CommandReceipt, type CommandSpec, type PaneContribution, PaneService } from './service.js'
export { type ReviewRequest, SubmitReview } from './submit-review.js'
export { currentPage, installPaneTools, navigate, PANE_TOOLS, textOutput } from './tools.js'
export { UserViewRegistry } from './user-views.js'

export const name = 'oryh-pane'
export const inject = ['typert', 'tools', 'agents', 'oryhClient', 'oryhData']

export function apply(ctx: Context): void {
  const pane = new PaneService(
    ctx,
    ctx.oryhClient,
    join(ctx.oryhData.directory, 'chat-bindings'),
    new UserViewRegistry(ctx),
  )
  const reviews = new SubmitReview(ctx, pane)
  ctx.provide('oryhPane', pane)
  ctx.provide('oryhReview', reviews)
  pane.userViews.install()
  reviews.install()
  installPaneTools(ctx, pane)
  pane.contribute({ name, tools: [...PANE_TOOLS, 'oryh_review_result'] })
  ctx.plugin(PaneRemote)
  ctx.effect(() => () => pane.dispose(), 'oryh pane')
}
