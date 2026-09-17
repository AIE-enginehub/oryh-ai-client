import { hkdfSync } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { OryhClientController } from './controller.js'
import { OryhClientError } from './errors.js'
import { OryhClientHost } from './host.js'
import { attachDomains, type OryhHostKit, VERIFY_TTL_MS } from './local-runtime.js'
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
 * The connection layer for one person on the server.
 *
 * Nothing here holds a credential: every ORYH and MCP request goes through `binding`, and the server
 * process decides what it lets through. Draft encryption keys come from the server instead of an OS
 * keychain, and there are no restorable connections — the one connection is the signed-in person.
 * @param options - trusted server wiring for one owner.
 * @returns the kit domain plugins build on.
 */
export function createServerOryhHost(options: ServerRuntimeOptions): OryhHostKit {
  if (!isAbsolute(options.dataDirectory) || !isAbsolute(options.agentsHome))
    throw new Error('ORYH server runtime paths must be absolute.')
  if (options.storeSecret.length !== 32) throw new Error('ORYH server store secret must be 32 bytes.')
  const refused = () => new OryhClientError('Server connections hold no local credential.', 'request-failed')
  const host = new OryhClientHost({
    serverBinding: { ...pick(options.binding), installSkills: true },
    credentialVault: {
      read: async () => {
        throw refused()
      },
      write: async () => {
        throw refused()
      },
      remove: async () => {},
    },
    fetcher: async () => {
      throw refused()
    },
    verifyTtlMs: VERIFY_TTL_MS,
  })
  const controller = new OryhClientController(host, {
    savedOperationStore: new JsonSavedOperationStore({ path: join(options.dataDirectory, 'saved-operations.json') }),
  })
  const storeKey = (label: string) => async () =>
    Buffer.from(hkdfSync('sha256', options.storeSecret, Buffer.alloc(0), `oryh-ai-client/${label}`, 32))
  return {
    host,
    controller,
    workflows: host.createWorkflowDefinitions(),
    skills: desktopSkillService(host.createSkillBundle(join(options.agentsHome, 'skills'))),
    mcp: host.createMcpClient(),
    data: { directory: options.dataDirectory, storeKey },
    abort: () => {},
  }
}

/** The same business runtime the desktop gets, for one person on the server, with every domain attached. */
export function createServerOryhRuntime(options: ServerRuntimeOptions) {
  return attachDomains(createServerOryhHost(options))
}

/** Copy only the binding's own members, so a spread cannot carry anything else along. */
function pick(binding: ServerBinding): ServerBinding {
  return {
    origin: binding.origin,
    identity: binding.identity,
    signal: binding.signal,
    send: (request, signal) => binding.send(request, signal),
  }
}
