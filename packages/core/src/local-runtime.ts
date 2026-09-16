import { desktopSkillService } from './skill-service.js'
import type {ProjectRecord} from '@oryh/ai-client-projects'
import { EncryptedRevisionStore } from '@oryh/ai-client-store'
import { EncryptedTimesheetStore } from '@oryh/ai-client-timesheets'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { EncryptedExpenseStore } from '@oryh/ai-client-expenses'
import { JsonConnectionStore } from './connection-store.js'
import { JsonSavedOperationStore } from './saved-operations.js'
import { KeychainCredentialVault } from './credentials.js'
import { fileCredentialHandoff } from './credential-handoff.js'
import { OryhClientController } from './controller.js'
import { OryhClientHost } from './host.js'
import { OryhClientRemoteAdapter } from './remote.js'

/** Host-owned credential and business runtime for the DSH plugin. */
export function createLocalOryhRuntime(dataDirectory = defaultOryhDataDirectory()) {
  if (!isAbsolute(dataDirectory)) throw new Error('ORYH dataDirectory must be an absolute path.')
  if (typeof globalThis.fetch !== 'function') throw new Error('ORYH requires a Host runtime with fetch.')
  const lifetime = new AbortController()
  const host = new OryhClientHost({
    credentialVault: new KeychainCredentialVault(),
    connectionStore: new JsonConnectionStore({ path: join(dataDirectory, 'connections.json') }),
    // Set only by a deployment whose login gateway signs the person in before the client opens.
    ...(process.env.ORYH_CREDENTIAL_HANDOFF ? { credentialHandoff: fileCredentialHandoff(process.env.ORYH_CREDENTIAL_HANDOFF) } : {}),
    fetcher: (input, init) => {
      lifetime.signal.throwIfAborted()
      const signal = init?.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal
      return globalThis.fetch(input, { ...init, signal })
    },
  })
  const controller = new OryhClientController(host, {
    savedOperationStore: new JsonSavedOperationStore({ path: join(dataDirectory, 'saved-operations.json') }),
  })
  // One reader for every domain: which object types this tenant governs is a server fact, and each
  // domain's confirm asks the same question before requiring a pre-submit review.
  const workflows = host.createWorkflowDefinitions()
  return {
    controller,
    records:host.createRecordRemote(),
    abort: () => lifetime.abort(),
    remote: new OryhClientRemoteAdapter(controller),
    todoDetails: host.createTodoDetailRemote(),
    projects:host.createProjectRemote(new EncryptedRevisionStore<ProjectRecord>(join(dataDirectory,'projects'),undefined,'ORYH AI Client Project Encryption')),
    workflows,
    timesheets: host.createTimesheetRemote(new EncryptedTimesheetStore(join(dataDirectory, 'timesheets'))),
    expenses: host.createExpenseRemote(new EncryptedExpenseStore(join(dataDirectory, 'expenses'))),
    // ORYH's own convention, and the root Harness scans by default: skills are named per
    // employer, so one agent can serve two companies out of the same directory.
    skills: desktopSkillService(host.createSkillBundle(join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills'))),
    // The same MCP endpoint the skills come from; the agent's ORYH tools call through it.
    mcp: host.createMcpClient(),
  }
}

/** OS-specific application data path; credentials remain in the OS vault. */
export function defaultOryhDataDirectory(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ORYH AI Client')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'ORYH AI Client')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'oryh-ai-client')
}
