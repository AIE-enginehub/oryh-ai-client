import { Entry } from '@napi-rs/keyring'
import type { ConnectionId } from './brand.js'
import type { ConnectionSummary } from './connections.js'
import { OryhClientError } from './errors.js'

/** Secret pair returned by the ORYH device flow and refresh endpoint. */
export interface CredentialPair {
  readonly accessKey: string
  readonly refreshToken: string
  readonly expiresAt: string | null
}

/** Host-only storage for short-lived ORYH access and refresh credentials. */
export interface CredentialVault {
  /** Bind persisted credentials to the verified server, account and tenant for this connection. */
  bindConnection?(connection: ConnectionSummary): Promise<void>
  read(connectionId: ConnectionId): Promise<CredentialPair | undefined>
  /** Reconcile another Host's token rotation before refreshing a cached credential. */
  readFresh?(connectionId: ConnectionId): Promise<CredentialPair | undefined>
  write(connectionId: ConnectionId, credential: CredentialPair): Promise<void>
  remove(connectionId: ConnectionId): Promise<void>
}

/** Ephemeral vault for tests and trusted server bindings; desktop persistence uses the Harness service. */
export class MemoryCredentialVault implements CredentialVault {
  readonly #credentials = new Map<ConnectionId, CredentialPair>()

  async read(connectionId: ConnectionId): Promise<CredentialPair | undefined> {
    return this.#credentials.get(connectionId)
  }

  async write(connectionId: ConnectionId, credential: CredentialPair): Promise<void> {
    this.#credentials.set(connectionId, credential)
  }

  async remove(connectionId: ConnectionId): Promise<void> {
    this.#credentials.delete(connectionId)
  }
}

/** Native keychain entry surface, injected by tests without accessing an operating-system store. */
export interface KeychainEntry {
  /** Read the stored password or `null` when this account has no entry. */
  getPassword(): string | null
  /** Replace this account's stored password. */
  setPassword(password: string): void
  /** Delete this account's credential; false means it was already absent. */
  deleteCredential(): boolean
}

/** Creates one system-keychain entry for a service and account pair. */
export type KeychainEntryFactory = (service: string, account: string) => KeychainEntry

/** Configuration of the system-keychain credential adapter. */
export interface KeychainCredentialVaultOptions {
  /** Stable service label visible in the user's operating-system credential manager. */
  readonly serviceName?: string
  /** Test seam; production uses @napi-rs/keyring's native Entry implementation. */
  readonly entryFactory?: KeychainEntryFactory
}

const DEFAULT_KEYCHAIN_SERVICE = 'ORYH AI Client'

type KeychainSnapshot =
  | { readonly value: CredentialPair | undefined; readonly error?: never }
  | { readonly error: OryhClientError; readonly value?: never }

/**
 * Legacy migration adapter backed by the native macOS Keychain, Windows
 * Credential Manager, or Linux Secret Service supplied by @napi-rs/keyring.
 * New desktop logins use Harness records; this adapter reads older installations.
 * It stores one serialized credential pair per opaque local connection ID;
 * no credential is written to application files or returned to the browser.
 * Normal requests reuse a Host-lifetime memory snapshot. Token renewal explicitly
 * reconciles the OS store; writes replace the snapshot and removal clears it.
 * Failed OS access is latched rather than repeatedly prompting during retries.
 */
export class KeychainCredentialVault implements CredentialVault {
  readonly #serviceName: string
  readonly #entryFactory: KeychainEntryFactory
  readonly #snapshots = new Map<ConnectionId, KeychainSnapshot>()

  constructor(options: KeychainCredentialVaultOptions = {}) {
    this.#serviceName = options.serviceName ?? DEFAULT_KEYCHAIN_SERVICE
    this.#entryFactory = options.entryFactory ?? ((service, account) => new Entry(service, account))
  }

  async read(connectionId: ConnectionId): Promise<CredentialPair | undefined> {
    return this.value(this.#snapshots.get(connectionId) ?? this.load(connectionId))
  }

  async readFresh(connectionId: ConnectionId): Promise<CredentialPair | undefined> {
    // Denial is not permission to ask again on each automatic retry. A successful
    // explicit sign-in write or a new Host lifetime can unlock this state.
    const previous = this.#snapshots.get(connectionId)
    if (previous?.error) throw previous.error
    return this.value(this.load(connectionId))
  }

  private load(connectionId: ConnectionId): KeychainSnapshot {
    let snapshot: KeychainSnapshot
    try {
      const raw = this.entry(connectionId).getPassword()
      snapshot = { value: raw === null ? undefined : decodeCredential(raw) }
    } catch {
      snapshot = { error: credentialStoreError('read') }
    }
    this.#snapshots.set(connectionId, snapshot)
    return snapshot
  }

  private value(snapshot: KeychainSnapshot): CredentialPair | undefined {
    if (snapshot.error) throw snapshot.error
    // Callers must not be able to mutate the process-local credential snapshot.
    return snapshot.value === undefined ? undefined : { ...snapshot.value }
  }

  async write(connectionId: ConnectionId, credential: CredentialPair): Promise<void> {
    const encoded = encodeCredential(credential)
    try {
      this.entry(connectionId).setPassword(encoded)
    } catch {
      const error = credentialStoreError('write')
      this.#snapshots.set(connectionId, { error })
      throw error
    }
    this.#snapshots.set(connectionId, { value: { ...credential } })
  }

  async remove(connectionId: ConnectionId): Promise<void> {
    try {
      this.entry(connectionId).deleteCredential()
    } catch {
      const error = credentialStoreError('remove')
      this.#snapshots.set(connectionId, { error })
      throw error
    }
    this.#snapshots.set(connectionId, { value: undefined })
  }

  private entry(connectionId: ConnectionId): KeychainEntry {
    return this.#entryFactory(this.#serviceName, `connection:${connectionId}`)
  }
}

function encodeCredential(credential: CredentialPair): string {
  validateCredential(credential)
  return JSON.stringify(credential)
}

function decodeCredential(raw: string): CredentialPair {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new OryhClientError('ORYH credential data in the system keychain is invalid.', 'credential-store-failed')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OryhClientError('ORYH credential data in the system keychain is invalid.', 'credential-store-failed')
  }
  const fields = value as Record<string, unknown>
  const credential: CredentialPair = {
    accessKey: fields.accessKey as string,
    refreshToken: fields.refreshToken as string,
    expiresAt: fields.expiresAt as string | null,
  }
  try {
    validateCredential(credential)
  } catch {
    throw new OryhClientError('ORYH credential data in the system keychain is invalid.', 'credential-store-failed')
  }
  return credential
}

function validateCredential(credential: CredentialPair): void {
  if (
    typeof credential.accessKey !== 'string' ||
    credential.accessKey.length === 0 ||
    typeof credential.refreshToken !== 'string' ||
    credential.refreshToken.length === 0 ||
    (credential.expiresAt !== null && typeof credential.expiresAt !== 'string')
  ) {
    throw new TypeError('Invalid ORYH credential pair')
  }
}

function credentialStoreError(operation: 'read' | 'write' | 'remove'): OryhClientError {
  return new OryhClientError(`ORYH credential store ${operation} failed.`, 'credential-store-failed')
}
