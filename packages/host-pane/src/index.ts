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
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { vocabularyRule } from '@oryh/ai-client-records'
import type {} from '@oryh/dsh-connection'
import { FORM_RULE, FORM_TOOLS, installFormTools } from './forms.js'
import { PaneRemote } from './remote.js'
import { PaneService } from './service.js'
import { SharedViews } from './shared-views.js'
import { SubmitReview } from './submit-review.js'
import { installPaneTools, PANE_TOOLS } from './tools.js'
import { UserViewRegistry } from './user-views.js'

export {
  attachedFiles,
  bytesOf,
  type ChatFile,
  type ChatFiles,
  type Conversation,
  describeChatFile,
  digestOf,
  fileChatFile,
  pickChatFile,
  UPLOAD_TOOL,
  uploadedAttachments,
} from './chat-files.js'
export {
  catalogRun,
  describeRun,
  lastAssistantText,
  lastTurnEnd,
  oneShotDescriptor,
  stopReasonOf,
} from './child-run.js'
export { type Clock, deploymentTimeZone, readClock, timeZoneOf } from './clock.js'
export { composed, type OryhComposed } from './composed.js'
export { FORM_RULE, FORM_TOOLS, fieldValue, fillForm, installFormTools } from './forms.js'
export {
  NAVIGATION_WITHOUT_PANE,
  NO_PAGE,
  NO_PAGE_CONTEXT,
  OPEN_KEEPS_PAGE,
  UNSAVED_KEEPS_PAGE,
} from './notices.js'
export type { PaneSession } from './registry.js'
export { PaneRemote } from './remote.js'
export {
  type CommandReceipt,
  type CommandSpec,
  objectTypeOf,
  type PaneContribution,
  PaneService,
} from './service.js'
export { type CopiedView, type SharedPages, SharedViews } from './shared-views.js'
export { REVIEW_PROVIDER, type ReviewRequest, SubmitReview } from './submit-review.js'
export { currentPage, installPaneTools, navigate, PANE_TOOLS, reveal, SHOW_PARAMETER, textOutput } from './tools.js'
export { USER_VIEW_LIMIT, UserViewRegistry } from './user-views.js'

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
  const shared = new SharedViews(ctx, pane)
  ctx.provide('oryhPane', pane)
  ctx.provide('oryhReview', reviews)
  ctx.provide('oryhSharedViews', shared)
  pane.userViews.install()
  shared.install()
  reviews.install()
  installPaneTools(ctx, pane)
  // The pages' own words for states and fields, given to the agent so Chat says what the page says.
  installFormTools(ctx, pane)
  pane.contribute({
    name,
    tools: [...PANE_TOOLS, ...FORM_TOOLS, 'oryh_review_result'],
    prompt: [vocabularyRule(), FORM_RULE],
    // A review runs in a session of its own (docs/56 §24): it reads, with ORYH's tools too, and reports.
    runner: {
      get tools() {
        return reviews.tools
      },
      reads: true,
      owns: sessionId => reviews.owns(sessionId),
    },
  })
  ctx.plugin(PaneRemote)
  ctx.effect(() => () => pane.dispose(), 'oryh pane')
}
