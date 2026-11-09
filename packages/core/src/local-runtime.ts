import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { JsonConnectionStore } from './connection-store.js'
import { OryhClientController } from './controller.js'
import { fileCredentialHandoff, ownerAdmission } from './credential-handoff.js'
import type { CredentialVault } from './credentials.js'
import { OryhClientHost } from './host.js'
import type { OryhMcpClient } from './mcp.js'
import { JsonSavedOperationStore } from './saved-operations.js'
import { desktopSkillService, type OryhSkillService } from './skill-service.js'
import type { WorkflowDefinitions } from './workflow.js'

/** Where a Host keeps a person's own data, and how a domain encrypts what it stores there. */
export interface OryhDataRoot {
  /** Absolute application data path. */
  readonly directory: string
  /**
   * The key a domain store encrypts with, by store label. Absent on the desktop; present on the server, where keys derive from one secret.
   */
  readonly storeKey?: (label: string) => () => Promise<Buffer>
}

/**
 * The connection layer one Host runs on: the client host with its credentials and transport, the
 * controller browsers talk to, and the services every domain shares. Domain plugins build their own
 * services on `host` (`createDomainReads`); nothing here knows a domain.
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
 * The desktop connection layer: injected Host credentials, restorable connections, a local data root.
 * @param dataDirectory - absolute application data path; the platform default when omitted.
 * @returns the kit domain plugins build on.
 */
export function createLocalOryhHost(dataDirectory: string, credentialVault: CredentialVault): OryhHostKit {
  if (!isAbsolute(dataDirectory)) throw new Error('ORYH dataDirectory must be an absolute path.')
  if (typeof globalThis.fetch !== 'function') throw new Error('ORYH requires a Host runtime with fetch.')
  const lifetime = new AbortController()
  const host = new OryhClientHost({
    credentialVault,
    connectionStore: new JsonConnectionStore({ path: join(dataDirectory, 'connections.json') }),
    // Set only by a deployment whose login gateway signs the person in before the client opens.
    ...(process.env.ORYH_CREDENTIAL_HANDOFF
      ? { credentialHandoff: fileCredentialHandoff(process.env.ORYH_CREDENTIAL_HANDOFF) }
      : {}),
    // Set by the same deployment: the one person its gateway lets in is the one who may connect here.
    ...(process.env.ORYH_CONTAINER_OWNER
      ? { connectionAdmission: ownerAdmission(process.env.ORYH_CONTAINER_OWNER) }
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

/** OS-specific application data path; credentials stay in the injected Host provider. */
export function defaultOryhDataDirectory(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ORYH AI Client')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'ORYH AI Client')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'oryh-ai-client')
}
