import type { OryhIdentity } from './contracts.js'
import type { DelegatedResponse, OryhRequest } from './http.js'
import { OryhClientHost } from './host.js'
import { OryhClientError } from './errors.js'

/**
 * A business Host's link to the trusted server process that holds its person's ORYH grant.
 * Bound by trusted server code, never serializable plugin config or a browser Remote argument.
 */
export interface ServerBinding {
  readonly origin: string
  readonly identity: OryhIdentity
  readonly signal: AbortSignal
  /** Send one ORYH request under that grant; the server process decides what it lets through. */
  send(request: OryhRequest, signal: AbortSignal): Promise<DelegatedResponse>
  /** Whether this Host may install skills read over MCP into its own skills directory. */
  readonly installSkills?: boolean
}

/** Bound by trusted server code, not serializable plugin config or a browser Remote argument. */
export interface ServerReadBinding {
  readonly origin: string
  readonly identity: OryhIdentity
  readonly signal: AbortSignal
  request(request: OryhRequest, signal: AbortSignal): Promise<unknown>
}
const denied = () => new OryhClientError('Operation is outside the server read-only pilot.', 'request-failed')
const paths = new Set(['/auth/me', '/projects', '/todos', '/expense-claims'])

/** Only the existing core list operations are admitted until per-operation writes are integrated. */
export function assertServerRead(request: OryhRequest): void {
  if ((request.method ?? 'GET') !== 'GET' || request.body !== undefined || /[\\#]/.test(request.path) || request.path.split('?')[0]!.includes('%')) throw denied()
  const url = new URL(request.path, 'https://bound.invalid')
  if (url.origin !== 'https://bound.invalid' || !paths.has(url.pathname) || request.path.split('?')[0] !== url.pathname) throw denied()
}

/** Reuses the production business Host without any keychain, fake key, device login or ZIP install. */
export async function createServerReadHost(binding: ServerReadBinding): Promise<OryhClientHost> {
  const origin = new URL(binding.origin)
  if (origin.protocol !== 'https:' || origin.origin !== binding.origin || !binding.identity.user.id.trim() || !binding.identity.tenant.id.trim()) throw denied()
  binding.signal.throwIfAborted()
  const identity = structuredClone(binding.identity)
  const delegated: ServerBinding = { origin: origin.origin, identity, signal: binding.signal,
    send: async (request, signal) => { assertServerRead(request); signal.throwIfAborted(); return { status: 200, body: await binding.request(request, signal) } } }
  const host = new OryhClientHost({
    serverBinding: delegated,
    credentialVault: { read: async () => { throw denied() }, write: async () => { throw denied() }, remove: async () => {} },
    fetcher: async () => { throw denied() },
  })
  await host.connections()
  return host
}
