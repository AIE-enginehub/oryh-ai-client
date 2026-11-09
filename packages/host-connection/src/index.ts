/**
 * The ORYH connection layer as a Harness Host plugin: who this Host is signed in as, how it reaches
 * ORYH, and the services every business domain shares. Domain plugins inject what they need from
 * here; nothing here knows what a timesheet is.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  createLocalOryhHost,
  defaultOryhDataDirectory,
  JsonConnectionStore,
  type OryhClientController,
  type OryhClientHost,
  type OryhHostKit,
  type OryhMcpClient,
  type OryhSkillService,
  type WorkflowDefinitions,
} from '@oryh/ai-client-core'
import { HarnessCredentialVault } from './harness-credentials.js'
import { LegacyKeychainReader } from './legacy-keychain.js'
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
  /** The key a domain store encrypts with, by store label; absent on the desktop. */
  readonly storeKey?: (label: string) => () => Promise<Buffer>
  readonly capabilities: ChatCapabilities
}

/** One thing a colleague of this enterprise shared, as the deployment's library hands it over. */
export interface SharedEntry {
  readonly kind: 'menu' | 'page'
  readonly id: string
  readonly title: string
  /** Who shared it, by name. */
  readonly author: string
  /** Whether this person is that author: only they may replace or withdraw it. */
  readonly mine: boolean
  readonly updatedAt: string
  /** The definition; a list of pages leaves it out, and `get` brings it. */
  readonly body?: unknown
}

/**
 * What colleagues of this enterprise share with each other: menu entries and custom pages, as their
 * definitions. Kept by the deployment, not by ORYH and not on any one person's disk, so it is there only
 * on the server version; on the desktop there is nobody to share with, and no such service.
 */
export interface OryhLibrary {
  list(kind: SharedEntry['kind']): Promise<SharedEntry[]>
  get(kind: SharedEntry['kind'], id: string): Promise<SharedEntry | undefined>
  /** Share, or replace what this person shared under the same id. */
  put(item: Pick<SharedEntry, 'kind' | 'id' | 'title'> & { body: unknown }): Promise<SharedEntry>
  /** Withdraw what this person shared; false when nothing of theirs had that id. */
  remove(kind: SharedEntry['kind'], id: string): Promise<boolean>
  /** Told when anyone of this enterprise shares or withdraws something of a kind. */
  onChanged(listener: (kind: SharedEntry['kind']) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** What colleagues share with each other, where the deployment keeps it; absent on the desktop. */
    oryhLibrary: OryhLibrary
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
 * Single-user composition: the desktop, whose Harness credentials service holds enterprise grants.
 *
 * The server never loads this plugin: there, `@oryh/dsh-server-host` provides the same services
 * from the owner link, and the server bundle disables this row.
 */
export interface Config {
  readonly developmentOnly: boolean
  /** Absolute application data path; omitted uses the standard ORYH application directory. */
  readonly dataDirectory?: string
  /**
   * Whether the Chat agent gets a shell. Off where no sandbox backend can confine it, as in the Docker
   * image: there every command was refused, and the agent asked the person for full access instead.
   */
  readonly shell?: boolean
  /**
   * A directory to have ready as this person's workspace, where the deployment made one. Harness asks
   * someone with no workspace to pick a directory before it takes a message, in a dialog in English that
   * opened on their first send and threw the message away. A workspace registered here is found there,
   * and the first thing they type is sent.
   */
  readonly workspace?: string
}

export const Config: z<Config> = z.object({
  developmentOnly: z.boolean().required(),
  dataDirectory: z.string(),
  shell: z.boolean(),
  workspace: z.string(),
})

export const name = 'oryh-connection'
export const inject = ['typert', 'credentials']

const DESKTOP: ChatCapabilities = { shell: true, writes: true }

export const WORKSPACE_TITLE = 'ORYH'
const GENERATED_TITLES = new Set(['我的工作区', 'My workspace'])

/** What this plugin asks of Harness's workspace registry: a workspace over a directory, the same one each time. */
interface WorkspaceRegistry {
  create(path: string, title?: string): Promise<{ readonly title: string; setTitle(title: string): Promise<void> }>
}

/**
 * Register the deployment's directory as a workspace once Harness's registry is there.
 * A failure is logged and no more: the person can still pick a directory, as before.
 * @param ctx - the Host context.
 * @param directory - absolute path of an existing directory.
 */
export function readyWorkspace(ctx: Context, directory: string): void {
  ctx.inject(['workspaceRegistry'], inner => {
    const registry = (inner as unknown as { workspaceRegistry: WorkspaceRegistry }).workspaceRegistry
    // A persisted title is data, not locale copy, so it is one that reads the same in every language:
    // '我的工作区' stood in English pages and 'My workspace' in Chinese ones. Only titles this plugin once
    // gave are migrated; a workspace the person named themselves keeps its name.
    void registry
      .create(directory, WORKSPACE_TITLE)
      .then(async workspace => {
        if (GENERATED_TITLES.has(workspace.title)) await workspace.setTitle(WORKSPACE_TITLE)
      })
      .catch((reason: unknown) => {
        console.warn(
          `oryh-connection: workspace not registered: ${reason instanceof Error ? reason.message : String(reason)}`,
        )
      })
  })
}

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
  if (config.workspace) readyWorkspace(ctx, config.workspace)
  const directory = config.dataDirectory ?? defaultOryhDataDirectory()
  let legacy: LegacyKeychainReader | undefined
  const vault = new HarnessCredentialVault({
    credentials: ctx.credentials,
    dataDirectory: directory,
    connectionStore: new JsonConnectionStore({ path: join(directory, 'connections.json') }),
    legacyVault: () => (legacy ??= new LegacyKeychainReader()),
  })
  const kit: OryhHostKit = createLocalOryhHost(directory, vault)
  ctx.provide('oryhHost', kit.host)
  ctx.provide('oryhClient', kit.controller)
  ctx.provide('oryhWorkflows', kit.workflows)
  ctx.provide('oryhSkills', kit.skills)
  ctx.provide('oryhMcp', kit.mcp)
  ctx.provide('oryhData', { ...kit.data, capabilities: { ...DESKTOP, shell: config.shell !== false } })
  ctx.provide('oryhAbort', kit.abort)
  ctx.effect(
    () => () => {
      kit.abort()
      legacy?.dispose()
    },
    'oryh connection lifetime',
  )
  ctx.plugin(ConnectionRemote)
}
