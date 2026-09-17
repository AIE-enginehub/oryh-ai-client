import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { EncryptedExpenseStore } from '@oryh/ai-client-expenses'
import type { ProjectRecord } from '@oryh/ai-client-projects'
import { EncryptedRevisionStore } from '@oryh/ai-client-store'
import { EncryptedTimesheetStore } from '@oryh/ai-client-timesheets'
import { JsonConnectionStore } from './connection-store.js'
import { OryhClientController } from './controller.js'
import { fileCredentialHandoff } from './credential-handoff.js'
import { KeychainCredentialVault } from './credentials.js'
import { OryhClientHost } from './host.js'
import type { OryhMcpClient } from './mcp.js'
import { OryhClientRemoteAdapter } from './remote.js'
import { JsonSavedOperationStore } from './saved-operations.js'
import { desktopSkillService, type OryhSkillService } from './skill-service.js'
import type { WorkflowDefinitions } from './workflow.js'

/** Where a Host keeps a person's own data, and how a domain encrypts what it stores there. */
export interface OryhDataRoot {
  /** Absolute application data path. */
  readonly directory: string
  /**
   * The key a domain store encrypts with, by store label. Absent on the desktop, where each store
   * keeps its own key in the OS keychain; present on the server, where keys derive from one secret.
   */
  readonly storeKey?: (label: string) => () => Promise<Buffer>
}

/**
 * The connection layer one Host runs on: the client host with its credentials and transport, the
 * controller browsers talk to, and the services every domain shares. Domain plugins build their own
 * services on `host`; nothing here knows what a timesheet is.
 */
export interface OryhHostKit {
  readonly host: OryhClientHost
  readonly controller: OryhClientController
  /** Which object types this tenant governs with a workflow definition; every domain's confirm asks it. */
  readonly workflows: WorkflowDefinitions
  readonly skills: OryhSkillService
  /** The same MCP endpoint the skills come from; the agent's ORYH tools call through it. */
  readonly mcp: OryhMcpClient
  readonly data: OryhDataRoot
  /** Cancel every request in flight; the plugin calls it on unload. */
  readonly abort: () => void
}

/** How long one verification of an enterprise identity stays good for an agent's tools. */
export const VERIFY_TTL_MS = 30_000

/**
 * The desktop connection layer: OS keychain credentials, restorable connections, a local data root.
 * @param dataDirectory - absolute application data path; the platform default when omitted.
 * @returns the kit domain plugins build on.
 */
export function createLocalOryhHost(dataDirectory = defaultOryhDataDirectory()): OryhHostKit {
  if (!isAbsolute(dataDirectory)) throw new Error('ORYH dataDirectory must be an absolute path.')
  if (typeof globalThis.fetch !== 'function') throw new Error('ORYH requires a Host runtime with fetch.')
  const lifetime = new AbortController()
  const host = new OryhClientHost({
    credentialVault: new KeychainCredentialVault(),
    connectionStore: new JsonConnectionStore({ path: join(dataDirectory, 'connections.json') }),
    // Set only by a deployment whose login gateway signs the person in before the client opens.
    ...(process.env.ORYH_CREDENTIAL_HANDOFF
      ? { credentialHandoff: fileCredentialHandoff(process.env.ORYH_CREDENTIAL_HANDOFF) }
      : {}),
    fetcher: (input, init) => {
      lifetime.signal.throwIfAborted()
      const signal = init?.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal
      return globalThis.fetch(input, { ...init, signal })
    },
    verifyTtlMs: VERIFY_TTL_MS,
  })
  const controller = new OryhClientController(host, {
    savedOperationStore: new JsonSavedOperationStore({ path: join(dataDirectory, 'saved-operations.json') }),
  })
  return {
    host,
    controller,
    workflows: host.createWorkflowDefinitions(),
    // ORYH's own convention, and the root Harness scans by default: skills are named per
    // employer, so one agent can serve two companies out of the same directory.
    skills: desktopSkillService(
      host.createSkillBundle(join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills')),
    ),
    mcp: host.createMcpClient(),
    data: { directory: dataDirectory },
    abort: () => lifetime.abort(),
  }
}

/** Every domain service over one kit, as the runtime shape older callers and tests compose. */
export function attachDomains(kit: OryhHostKit) {
  const { host, data } = kit
  const key = (label: string) => data.storeKey?.(label)
  return {
    ...kit,
    records: host.createRecordRemote(),
    remote: new OryhClientRemoteAdapter(kit.controller),
    todoDetails: host.createTodoDetailRemote(),
    projects: host.createProjectRemote(
      new EncryptedRevisionStore<ProjectRecord>(
        join(data.directory, 'projects'),
        key('projects'),
        'ORYH AI Client Project Encryption',
      ),
    ),
    timesheets: host.createTimesheetRemote(
      new EncryptedTimesheetStore(join(data.directory, 'timesheets'), key('timesheets')),
    ),
    expenses: host.createExpenseRemote(new EncryptedExpenseStore(join(data.directory, 'expenses'), key('expenses'))),
  }
}

/** Host-owned credential and business runtime, with every domain attached. */
export function createLocalOryhRuntime(dataDirectory = defaultOryhDataDirectory()) {
  return attachDomains(createLocalOryhHost(dataDirectory))
}

/** OS-specific application data path; credentials remain in the OS vault. */
export function defaultOryhDataDirectory(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ORYH AI Client')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'ORYH AI Client')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'oryh-ai-client')
}
