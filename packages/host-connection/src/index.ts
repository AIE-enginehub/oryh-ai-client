/**
 * The ORYH connection layer as a Harness Host plugin: who this Host is signed in as, how it reaches
 * ORYH, and the services every business domain shares. Domain plugins inject what they need from
 * here; nothing here knows what a timesheet is.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  createLocalOryhHost,
  defaultOryhDataDirectory,
  type OryhClientController,
  type OryhClientHost,
  type OryhHostKit,
  type OryhMcpClient,
  type OryhSkillService,
  type WorkflowDefinitions,
} from '@oryh/ai-client-core'
import { ConnectionRemote } from './remote.js'
import type { ChatCapabilities } from './types.js'

export { ConnectionRemote } from './remote.js'
export { RemoteCalls } from './remote-calls.js'
export type { ChatCapabilities } from './types.js'

/**
 * Where a Host keeps this person's data, and what the deployment lets the agent do.
 *
 * Spelled out rather than extending `OryhDataRoot`: the typert generator models a service's
 * heritage, and a base declared in another package is a shape it does not resolve.
 */
export interface OryhHostData {
  /** Absolute application data path. */
  readonly directory: string
  /** The key a domain store encrypts with, by store label; absent on the desktop, where the OS keychain holds it. */
  readonly storeKey?: (label: string) => () => Promise<Buffer>
  readonly capabilities: ChatCapabilities
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The client host: connections, verification, and the factories domain services are built with. */
    oryhHost: OryhClientHost
    /** The controller browsers and tools talk to. */
    oryhClient: OryhClientController
    oryhWorkflows: WorkflowDefinitions
    oryhSkills: OryhSkillService
    oryhMcp: OryhMcpClient
    oryhData: OryhHostData
    /** Cancel every ORYH request in flight. */
    oryhAbort: () => void
  }
}

/**
 * Single-user composition: the desktop, where the OS keychain holds this person's credentials.
 *
 * The server never loads this plugin: there, `@oryh/dsh-server-host` provides the same services
 * from the owner link, and the server bundle disables this row.
 */
export interface Config {
  readonly developmentOnly: boolean
  /** Absolute application data path; omitted uses the standard ORYH application directory. */
  readonly dataDirectory?: string
}

export const Config: z<Config> = z.object({
  developmentOnly: z.boolean().required(),
  dataDirectory: z.string(),
})

export const name = 'oryh-connection'
export const inject = ['typert']

const DESKTOP: ChatCapabilities = { shell: true, writes: true }

/**
 * Provide the connection layer and the `oryh` Remote namespace.
 * No HTTP listener, browser transport, model loop, or unrestricted tool is installed.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.developmentOnly !== true) {
    throw new Error(
      'oryh-connection: requires developmentOnly: true; the multi-user server runs @oryh/dsh-server-host instead',
    )
  }
  const kit: OryhHostKit = createLocalOryhHost(config.dataDirectory ?? defaultOryhDataDirectory())
  ctx.provide('oryhHost', kit.host)
  ctx.provide('oryhClient', kit.controller)
  ctx.provide('oryhWorkflows', kit.workflows)
  ctx.provide('oryhSkills', kit.skills)
  ctx.provide('oryhMcp', kit.mcp)
  ctx.provide('oryhData', { ...kit.data, capabilities: DESKTOP })
  ctx.provide('oryhAbort', kit.abort)
  ctx.effect(() => () => kit.abort(), 'oryh connection lifetime')
  ctx.plugin(ConnectionRemote)
}
