/** ORYH grants in the public Harness credential seam; the OS vault is read only for migration. */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { type CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials/types'
import {
  type ConnectionId,
  type ConnectionStore,
  type ConnectionSummary,
  type CredentialPair,
  type CredentialVault,
  OryhClientError,
} from '@oryh/ai-client-core'

type Records = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>
type Binding = { origin: string; userId: string; tenantId: string }
interface Payload {
  version: 1
  namespace: string
  connectionId: string
  binding: Binding | null
  credential: CredentialPair | null
}

export class HarnessCredentialVault implements CredentialVault {
  readonly #namespace: string
  readonly #bindings = new Map<ConnectionId, Binding>()
  readonly #legacyConnections: Promise<readonly ConnectionSummary[]>
  readonly #migrations = new Map<ConnectionId, Promise<void>>()
  #legacy: CredentialVault | undefined

  constructor(
    private readonly options: {
      credentials: Records
      dataDirectory: string
      connectionStore: ConnectionStore
      legacyVault: () => CredentialVault
    },
  ) {
    if (!isAbsolute(options.dataDirectory)) throw new Error('ORYH dataDirectory must be an absolute path.')
    this.#namespace = hash(resolve(options.dataDirectory))
    // Snapshot only the pre-existing metadata. New logins never discover the OS vault.
    this.#legacyConnections = options.connectionStore.load()
    void this.#legacyConnections.catch(() => {})
  }

  async bindConnection(connection: ConnectionSummary): Promise<void> {
    await safe(async () => {
      const expected = binding(connection)
      this.#bindings.set(connection.id, expected)
      await this.options.credentials.modifyRecord(this.key(connection.id), async current => {
        if (!current) return undefined
        const payload = this.decode(connection.id, current)
        if (payload.credential === null || payload.binding !== null) return undefined
        return { kind: 'grant', payload: { ...payload, binding: expected } }
      })
    })
  }

  async read(id: ConnectionId): Promise<CredentialPair | undefined> {
    return safe(async () => {
      const record = await this.options.credentials.readRecord(this.key(id))
      if (record) return this.value(id, record)
      let migration = this.#migrations.get(id)
      if (!migration) {
        migration = this.migrate(id)
        this.#migrations.set(id, migration)
      }
      await migration
      // Remember migration completion/denial, never a secret snapshot. An external
      // removal or another Host's rotation must be visible on the next request.
      const committed = await this.options.credentials.readRecord(this.key(id))
      return committed ? this.value(id, committed) : undefined
    })
  }

  async readFresh(id: ConnectionId): Promise<CredentialPair | undefined> {
    return safe(async () => {
      // A no-op transaction reconciles the latest document under Harness's cross-process lock.
      const record = await this.options.credentials.modifyRecord(this.key(id), async () => undefined)
      return record ? this.value(id, record) : this.read(id)
    })
  }

  async write(id: ConnectionId, credential: CredentialPair): Promise<void> {
    await safe(async () => {
      const payload = this.payload(id, pair(credential))
      await this.options.credentials.modifyRecord(this.key(id), async () => ({ kind: 'grant', payload }))
      this.#migrations.set(id, Promise.resolve())
    })
  }

  async remove(id: ConnectionId): Promise<void> {
    await safe(async () => {
      // A credential-free tombstone prevents an old OS entry from resurrecting a signed-out account.
      const payload = this.payload(id, null)
      await this.options.credentials.modifyRecord(this.key(id), async () => ({ kind: 'grant', payload }))
      this.#bindings.delete(id)
      this.#migrations.set(id, Promise.resolve())
    })
  }

  private async migrate(id: ConnectionId): Promise<void> {
    const connection = (await this.#legacyConnections).find(value => value.id === id)
    if (!connection) return undefined
    const expected = this.#bindings.get(id)
    if (!expected || !sameBinding(expected, binding(connection))) throw failure()
    // The local validation build used one record for the whole Profile. Convert
    // it before considering Keychain, including its empty/sign-out state.
    const aggregate = await this.options.credentials.readRecord(
      credentialKey('oryh-connection', `vault-${this.#namespace}`),
    )
    let legacy: CredentialPair | undefined
    if (aggregate !== undefined) {
      legacy = aggregateCredential(aggregate, id)
    } else {
      this.#legacy ??= this.options.legacyVault()
      legacy = await this.#legacy.read(id)
    }
    // Commit first; retain the old entry for recovery, and never write it during refresh/sign-out.
    const record = await this.options.credentials.modifyRecord(this.key(id), async current =>
      current ? undefined : { kind: 'grant', payload: this.payload(id, legacy ? pair(legacy) : null) },
    )
    if (record) this.value(id, record)
  }

  private key(id: ConnectionId) {
    return credentialKey('oryh-connection', `connection-${hash(JSON.stringify([this.#namespace, id]))}`)
  }

  private payload(id: ConnectionId, credential: CredentialPair | null): Payload {
    return {
      version: 1,
      namespace: this.#namespace,
      connectionId: id,
      binding: this.#bindings.get(id) ?? null,
      credential,
    }
  }

  private decode(id: ConnectionId, record: CredentialRecord): Payload {
    if (record.kind !== 'grant' || !object(record.payload)) throw failure()
    const p = record.payload
    if (p.version !== 1 || p.namespace !== this.#namespace || p.connectionId !== id) throw failure()
    if (
      p.binding !== null &&
      (!object(p.binding) ||
        typeof p.binding.origin !== 'string' ||
        typeof p.binding.userId !== 'string' ||
        typeof p.binding.tenantId !== 'string')
    )
      throw failure()
    const expected = this.#bindings.get(id)
    // A pending device-flow grant is bound only after /auth/me succeeds. Restored
    // grants must match the identity in the non-secret connection metadata.
    if (p.credential !== null && expected && p.binding !== null && !sameBinding(expected, p.binding as Binding))
      throw failure()
    return {
      version: 1,
      namespace: p.namespace,
      connectionId: id,
      binding: p.binding as Binding | null,
      credential: p.credential === null ? null : pair(p.credential),
    }
  }

  private value(id: ConnectionId, record: CredentialRecord): CredentialPair | undefined {
    const p = this.decode(id, record)
    if (p.credential === null) {
      this.#bindings.delete(id)
      return undefined
    }
    return { ...p.credential }
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function binding(c: ConnectionSummary): Binding {
  return { origin: c.origin, userId: c.identity.user.id, tenantId: c.identity.tenant.id }
}
function sameBinding(a: Binding, b: Binding): boolean {
  return a.origin === b.origin && a.userId === b.userId && a.tenantId === b.tenantId
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function pair(value: unknown): CredentialPair {
  if (
    !object(value) ||
    typeof value.accessKey !== 'string' ||
    !value.accessKey ||
    typeof value.refreshToken !== 'string' ||
    !value.refreshToken ||
    (value.expiresAt !== null && typeof value.expiresAt !== 'string')
  )
    throw failure()
  return { accessKey: value.accessKey, refreshToken: value.refreshToken, expiresAt: value.expiresAt }
}
/** Read the prior local build's owner-scoped record without reviving an absent login. */
function aggregateCredential(record: CredentialRecord, id: ConnectionId): CredentialPair | undefined {
  if (record.kind !== 'grant' || !object(record.payload) || record.payload.version !== 1) throw failure()
  const connections = record.payload.connections
  if (!object(connections)) throw failure()
  for (const value of Object.values(connections)) pair(value)
  return Object.hasOwn(connections, id) ? pair(connections[id]) : undefined
}
function failure(): OryhClientError {
  return new OryhClientError(
    'ORYH credential storage is unavailable. Reconnect this account or restart to retry migration.',
    'credential-store-failed',
  )
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch {
    throw failure()
  }
}
