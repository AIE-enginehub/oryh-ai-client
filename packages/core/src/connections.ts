import { type ConnectionId, connectionId } from './brand.js'
import type { OryhIdentity } from './contracts.js'
import { OryhClientError } from './errors.js'

/** Non-secret ORYH connection facts that may be sent to the UI. */
export interface ConnectionSummary {
  readonly id: ConnectionId
  readonly origin: string
  readonly identity: OryhIdentity
  readonly connectedAt: string
}

interface NewConnection {
  readonly origin: string
  readonly identity: OryhIdentity
}

/** Owns local connection scope and deliberately never stores credentials. */
export class ConnectionRegistry {
  readonly #connections = new Map<ConnectionId, ConnectionSummary>()
  readonly #verified = new Set<ConnectionId>()
  #nextId = 1

  /** Register a connection after Host-side authentication has completed. */
  add(connection: NewConnection, connectedAt = new Date().toISOString()): ConnectionSummary {
    const origin = normalizeOrigin(connection.origin)
    const id = this.nextId()
    const summary: ConnectionSummary = {
      id,
      origin,
      identity: connection.identity,
      connectedAt,
    }
    this.#connections.set(id, summary)
    return summary
  }

  /** Restore non-secret summaries only after the Host confirms their credential entries exist. */
  restore(connections: readonly ConnectionSummary[]): void {
    const restored = new Map<ConnectionId, ConnectionSummary>()
    for (const connection of connections) {
      if (restored.has(connection.id)) {
        throw new OryhClientError(
          'ORYH connection restore contains duplicate connection IDs.',
          'connection-store-failed',
        )
      }
      restored.set(connection.id, {
        ...connection,
        origin: normalizeOrigin(connection.origin),
      })
    }
    this.#connections.clear()
    this.#verified.clear()
    for (const [id, connection] of restored) this.#connections.set(id, connection)
    this.#nextId = 1
    while (this.#connections.has(connectionId(`oryh-${this.#nextId}`))) this.#nextId += 1
  }

  /** Return the connection or fail before a request can cross an unknown scope. */
  require(connectionId: ConnectionId): ConnectionSummary {
    const connection = this.#connections.get(connectionId)
    if (connection === undefined) {
      throw new OryhClientError('The ORYH connection no longer exists.', 'connection-not-found')
    }
    return connection
  }

  /** Return a connection only after the current Host process verified its credential against `/auth/me`. */
  requireVerified(connectionId: ConnectionId): ConnectionSummary {
    const connection = this.require(connectionId)
    if (!this.#verified.has(connectionId)) {
      throw new OryhClientError(
        'The ORYH connection must be verified before a business operation can run.',
        'connection-verification-required',
      )
    }
    return connection
  }

  /** Freeze business access before revalidation or credential removal begins. */
  revokeVerification(connectionId: ConnectionId): void {
    this.#verified.delete(connectionId)
  }

  /** Return summaries for settings and connection selection. */
  list(): readonly ConnectionSummary[] {
    return [...this.#connections.values()]
  }

  /** Replace the temporary device-flow identity before publishing the connection. */
  replaceIdentity(connectionId: ConnectionId, identity: OryhIdentity): ConnectionSummary {
    const current = this.require(connectionId)
    const connection: ConnectionSummary = { ...current, identity }
    this.#connections.set(connectionId, connection)
    return connection
  }

  /** Publish a server-verified identity and permit this process to execute its business operations. */
  markVerified(connectionId: ConnectionId, identity: OryhIdentity): ConnectionSummary {
    const connection = this.replaceIdentity(connectionId, identity)
    this.#verified.add(connectionId)
    return connection
  }

  /** Remove a disconnected connection. The credential vault is cleared by the caller. */
  remove(connectionId: ConnectionId): void {
    this.#connections.delete(connectionId)
    this.#verified.delete(connectionId)
  }

  private nextId(): ConnectionId {
    while (this.#connections.has(connectionId(`oryh-${this.#nextId}`))) this.#nextId += 1
    const id = connectionId(`oryh-${this.#nextId}`)
    this.#nextId += 1
    return id
  }
}

/** Normalize and restrict an ORYH deployment origin. */
export function normalizeOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OryhClientError('ORYH server address is not a valid URL.', 'unsupported-origin')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OryhClientError('ORYH server address must use HTTP or HTTPS.', 'unsupported-origin')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new OryhClientError('ORYH server address must be an origin only.', 'unsupported-origin')
  }
  return url.origin
}
