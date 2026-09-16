import { hkdfSync } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { ProjectRecord } from '@oryh/ai-client-projects'
import { EncryptedRevisionStore } from '@oryh/ai-client-store'
import { EncryptedTimesheetStore } from '@oryh/ai-client-timesheets'
import { EncryptedExpenseStore } from '@oryh/ai-client-expenses'
import { OryhClientController } from './controller.js'
import { OryhClientError } from './errors.js'
import { OryhClientHost } from './host.js'
import { OryhClientRemoteAdapter } from './remote.js'
import { JsonSavedOperationStore } from './saved-operations.js'
import type { ServerBinding } from './server-read.js'
import { desktopSkillService } from './skill-service.js'

/** What a trusted server process hands one person's business Host. Never browser or model input. */
export interface ServerRuntimeOptions {
  /** The link to the process holding this person's ORYH grant. */
  readonly binding: ServerBinding
  /** This person's private data root; drafts and chat bindings live under it. */
  readonly dataDirectory: string
  /** Where this person's agent runtime scans for skills (`<agentsHome>/skills`). */
  readonly agentsHome: string
  /** 32-byte secret for this person's encrypted drafts; each store derives its own key from it. */
  readonly storeSecret: Buffer
}

/**
 * The same business runtime the desktop plugin gets, for one person on the server.
 *
 * Nothing here holds a credential: every ORYH and MCP request goes through `binding`, and the server
 * process decides what it lets through. Draft encryption keys come from the server instead of an OS
 * keychain, and there are no restorable connections — the one connection is the signed-in person.
 * @param options - trusted server wiring for one owner.
 * @returns the runtime shape `@oryh/dsh-host` composes, identical to `createLocalOryhRuntime`'s.
 */
export function createServerOryhRuntime(options: ServerRuntimeOptions) {
  if (!isAbsolute(options.dataDirectory) || !isAbsolute(options.agentsHome)) throw new Error('ORYH server runtime paths must be absolute.')
  if (options.storeSecret.length !== 32) throw new Error('ORYH server store secret must be 32 bytes.')
  const refused = () => new OryhClientError('Server connections hold no local credential.', 'request-failed')
  const host = new OryhClientHost({
    serverBinding: { ...pick(options.binding), installSkills: true },
    credentialVault: { read: async () => { throw refused() }, write: async () => { throw refused() }, remove: async () => {} },
    fetcher: async () => { throw refused() },
  })
  const controller = new OryhClientController(host, {
    savedOperationStore: new JsonSavedOperationStore({ path: join(options.dataDirectory, 'saved-operations.json') }),
  })
  const key = (label: string) => async () => Buffer.from(hkdfSync('sha256', options.storeSecret, Buffer.alloc(0), `oryh-ai-client/${label}`, 32))
  const workflows = host.createWorkflowDefinitions()
  return {
    controller,
    records: host.createRecordRemote(),
    abort: () => {},
    remote: new OryhClientRemoteAdapter(controller),
    todoDetails: host.createTodoDetailRemote(),
    projects: host.createProjectRemote(new EncryptedRevisionStore<ProjectRecord>(join(options.dataDirectory, 'projects'), key('projects'))),
    workflows,
    timesheets: host.createTimesheetRemote(new EncryptedTimesheetStore(join(options.dataDirectory, 'timesheets'), key('timesheets'))),
    expenses: host.createExpenseRemote(new EncryptedExpenseStore(join(options.dataDirectory, 'expenses'), key('expenses'))),
    skills: desktopSkillService(host.createSkillBundle(join(options.agentsHome, 'skills'))),
    mcp: host.createMcpClient(),
  }
}

/** Copy only the binding's own members, so a spread cannot carry anything else along. */
function pick(binding: ServerBinding): ServerBinding {
  return { origin: binding.origin, identity: binding.identity, signal: binding.signal, send: (request, signal) => binding.send(request, signal) }
}
