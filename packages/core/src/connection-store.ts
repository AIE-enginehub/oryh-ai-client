import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { connectionId } from './brand.js'
import { type ConnectionSummary, normalizeOrigin } from './connections.js'
import type { OryhIdentity } from './contracts.js'
import { OryhClientError } from './errors.js'

/** Non-secret local persistence for ORYH connection summaries. */
export interface ConnectionStore {
  /** Load all previously persisted connection summaries. */
  load(): Promise<readonly ConnectionSummary[]>
  /** Replace the complete non-secret connection summary set. */
  save(connections: readonly ConnectionSummary[]): Promise<void>
}

/** In-memory connection store used by tests and development-only compositions. */
export class MemoryConnectionStore implements ConnectionStore {
  #connections: readonly ConnectionSummary[]

  constructor(initial: readonly ConnectionSummary[] = []) {
    this.#connections = [...initial]
  }

  async load(): Promise<readonly ConnectionSummary[]> {
    return [...this.#connections]
  }

  async save(connections: readonly ConnectionSummary[]): Promise<void> {
    this.#connections = [...connections]
  }
}

/** Configuration for the local non-secret connection metadata file. */
export interface JsonConnectionStoreOptions {
  /** Absolute file path owned by the native client application data directory. */
  readonly path: string
}

const CONNECTION_STORE_VERSION = 1
const MAX_CONNECTION_STORE_BYTES = 1024 * 1024

/**
 * JSON metadata store for connection IDs, origins, and authenticated identity.
 * Credentials are intentionally absent: they live only in CredentialVault.
 */
export class JsonConnectionStore implements ConnectionStore {
  readonly #path: string

  constructor(options: JsonConnectionStoreOptions) {
    if (options.path.length === 0) {
      throw new OryhClientError('ORYH connection metadata path must not be empty.', 'connection-store-failed')
    }
    this.#path = options.path
  }

  async load(): Promise<readonly ConnectionSummary[]> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error: unknown) {
      if (isMissingFile(error)) return []
      throw storeError('read')
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONNECTION_STORE_BYTES) {
      throw new OryhClientError('ORYH connection metadata is too large.', 'connection-store-failed')
    }
    try {
      return decodeStore(JSON.parse(raw))
    } catch (error: unknown) {
      if (error instanceof OryhClientError) throw error
      throw new OryhClientError('ORYH connection metadata is invalid.', 'connection-store-failed')
    }
  }

  async save(connections: readonly ConnectionSummary[]): Promise<void> {
    const content = JSON.stringify({ version: CONNECTION_STORE_VERSION, connections }, undefined, 2)
    const directory = dirname(this.#path)
    const temporaryPath = join(directory, `.${basename(this.#path)}.${randomUUID()}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.#path)
    } catch {
      throw storeError('write')
    }
  }
}

function decodeStore(value: unknown): readonly ConnectionSummary[] {
  const record = asRecord(value)
  if (record.version !== CONNECTION_STORE_VERSION || !Array.isArray(record.connections)) {
    throw new OryhClientError('ORYH connection metadata is invalid.', 'connection-store-failed')
  }
  const seen = new Set<string>()
  return record.connections.map(item => {
    const connection = decodeConnection(item)
    if (seen.has(connection.id)) {
      throw new OryhClientError(
        'ORYH connection metadata contains duplicate connection IDs.',
        'connection-store-failed',
      )
    }
    seen.add(connection.id)
    return connection
  })
}

function decodeConnection(value: unknown): ConnectionSummary {
  const record = asRecord(value)
  const id = string(record.id)
  if (!/^oryh-[1-9][0-9]*$/u.test(id)) {
    throw new OryhClientError('ORYH connection metadata contains an invalid connection ID.', 'connection-store-failed')
  }
  const connectedAt = string(record.connectedAt)
  if (!Number.isFinite(Date.parse(connectedAt))) {
    throw new OryhClientError(
      'ORYH connection metadata contains an invalid connection time.',
      'connection-store-failed',
    )
  }
  return {
    id: connectionId(id),
    origin: normalizeOrigin(string(record.origin)),
    identity: decodeIdentity(record.identity),
    connectedAt,
  }
}

function decodeIdentity(value: unknown): OryhIdentity {
  const identity = asRecord(value)
  const user = asRecord(identity.user)
  const tenant = asRecord(identity.tenant)
  return {
    user: {
      id: string(user.id),
      email: string(user.email),
      name: nullableString(user.name),
      role: string(user.role),
      employeeId: nullableString(user.employeeId),
    },
    tenant: {
      id: string(tenant.id),
      slug: string(tenant.slug),
      name: nullableString(tenant.name),
      environmentId: nullableString(tenant.environmentId),
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OryhClientError('ORYH connection metadata is invalid.', 'connection-store-failed')
  }
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OryhClientError('ORYH connection metadata is invalid.', 'connection-store-failed')
  }
  return value
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  return string(value)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function storeError(operation: 'read' | 'write'): OryhClientError {
  return new OryhClientError(`ORYH connection metadata ${operation} failed.`, 'connection-store-failed')
}
