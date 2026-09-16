import { join } from 'node:path'
import { BusinessChat, type ChatCapabilities } from './business-chat.js'
import { defaultOryhDataDirectory } from '@oryh/ai-client-core'
/** ORYH business services contributed through the DSH Cordis Host plugin lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import { OryhRemote } from './remote.js'
import { serverRuntimeFromParent } from './server-runtime.js'
export * from './remote.js'
import { createLocalOryhRuntime } from '@oryh/ai-client-core'

/**
 * One person's business runtime on the multi-user server. An in-process launcher may provide it before
 * this plugin loads; otherwise it comes over the IPC channel of the control process that started this
 * Host. It never comes from plugin configuration, which is not a trusted channel.
 */
export interface OryhServerRuntime {
  readonly runtime: ReturnType<typeof createLocalOryhRuntime>
  /** This person's private data root, for state the plugin keeps itself (chat bindings). */
  readonly dataDirectory: string
  readonly capabilities: ChatCapabilities
}
declare module '@deepseek-ai/cordis' {
  interface Context { oryhServerRuntime: OryhServerRuntime }
}

/** Single-user development composition, or one owner's Host on the server (`mode: server`). */
export interface Config {
  readonly developmentOnly: boolean
  /** `server` takes the runtime the owner Host launcher provided instead of the OS keychain and local stores. */
  readonly mode?: 'desktop' | 'server'
  /** Absolute application data path; omitted uses the standard ORYH application directory. */
  readonly dataDirectory?: string
}

export const Config: z<Config> = z.object({
  developmentOnly: z.boolean().required(),
  mode: z.union(['desktop', 'server']),
  dataDirectory: z.string(),
})

export const name = 'oryh-client-host'
export const inject = ['typert', 'tools', 'agents', 'systemPrompt']

/**
 * Register Host-only business services backed by OS credentials and persistent stores.
 * No HTTP listener, browser transport, model loop, or unrestricted tool is installed.
 * Browser confirmations stay outside model tools; a separate session-bound tool reads the current todo.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const server = config.mode === 'server' ? ctx.get('oryhServerRuntime') ?? await serverRuntimeFromParent() : undefined
  if (server === undefined && config.developmentOnly !== true) {
    throw new Error('oryh-client-host: requires developmentOnly: true; production multi-user composition runs in server mode')
  }
  const runtime = server?.runtime ?? createLocalOryhRuntime(config.dataDirectory)
  const dataDirectory = server?.dataDirectory ?? config.dataDirectory ?? defaultOryhDataDirectory()
  ctx.provide('oryhClient', runtime.controller)
  ctx.provide('oryhExpenses', runtime.expenses)
  ctx.provide('oryhTimesheets', runtime.timesheets)
  ctx.provide('oryhRecords',runtime.records)
  ctx.provide('oryhProjects',runtime.projects)
  ctx.provide('oryhAbort', runtime.abort)
  ctx.plugin(OryhRemote)
  const chat = new BusinessChat(ctx, runtime.controller, runtime.todoDetails, join(dataDirectory, 'chat-bindings'), runtime.timesheets,runtime.projects, runtime.skills, runtime.mcp, server?.capabilities)
  // The page's disabled button is a hint; this is the gate. Wired here because the verdict lives in
  // the chat layer and the confirm lives in the timesheet service, and neither may import the other.
  // Every domain asks the same two questions before a submit: does the tenant govern this object
  // type, and did its review pass. Neither answer is compiled in — the first is the server's, the
  // second is the agent's.
  for (const domain of [runtime.timesheets, runtime.expenses]) {
    domain.setWorkflowLookup((id, objectType) => runtime.workflows.governed(id, objectType))
    domain.setSubmitGate((objectType, documentId, sessionId) => chat.reviews.assertPassed(objectType, documentId, sessionId))
  }
  ctx.provide('oryhSkills', runtime.skills)
  ctx.provide('oryhTodoDetails', runtime.todoDetails)
  ctx.provide('oryhChat', chat)
  chat.install()
}
