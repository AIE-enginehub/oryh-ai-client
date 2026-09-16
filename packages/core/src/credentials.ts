import { Entry } from '@napi-rs/keyring'
import type { ConnectionId } from './brand.js'
import { OryhClientError } from './errors.js'

/** Secret pair returned by the ORYH device flow and refresh endpoint. */
export interface CredentialPair {
  readonly accessKey: string
  readonly refreshToken: string
  readonly expiresAt: string | null
}

/** Host-only storage for short-lived ORYH access and refresh credentials. */
export interface CredentialVault {
  read(connectionId: ConnectionId): Promise<CredentialPair | undefined>
  write(connectionId: ConnectionId, credential: CredentialPair): Promise<void>
  remove(connectionId: ConnectionId): Promise<void>
}

/** Test and development-only vault; production adapters must use the OS keychain. */
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

/**
 * Production credential adapter backed by the native macOS Keychain, Windows
 * Credential Manager, or Linux Secret Service supplied by @napi-rs/keyring.
 * It stores one serialized credential pair per opaque local connection ID;
 * no credential is written to application files or returned to the browser.
 */
export class KeychainCredentialVault implements CredentialVault {
  readonly #serviceName: string
  readonly #entryFactory: KeychainEntryFactory

  constructor(options: KeychainCredentialVaultOptions = {}) {
    this.#serviceName = options.serviceName ?? DEFAULT_KEYCHAIN_SERVICE
    this.#entryFactory = options.entryFactory ?? ((service, account) => new Entry(service, account))
  }

  async read(connectionId: ConnectionId): Promise<CredentialPair | undefined> {
    let raw: string | null
    try {
      raw = this.entry(connectionId).getPassword()
    } catch {
      throw credentialStoreError('read')
    }
    if (raw === null) return undefined
    return decodeCredential(raw)
  }

  async write(connectionId: ConnectionId, credential: CredentialPair): Promise<void> {
    const encoded = encodeCredential(credential)
    try {
      this.entry(connectionId).setPassword(encoded)
    } catch {
      throw credentialStoreError('write')
    }
  }

  async remove(connectionId: ConnectionId): Promise<void> {
    try {
      this.entry(connectionId).deleteCredential()
    } catch {
      throw credentialStoreError('remove')
    }
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
  if (typeof credential.accessKey !== 'string' || credential.accessKey.length === 0
    || typeof credential.refreshToken !== 'string' || credential.refreshToken.length === 0
    || (credential.expiresAt !== null && typeof credential.expiresAt !== 'string')) {
    throw new TypeError('Invalid ORYH credential pair')
  }
}

function credentialStoreError(operation: 'read' | 'write' | 'remove'): OryhClientError {
  return new OryhClientError(
    `ORYH credential store ${operation} failed.`,
    'credential-store-failed',
  )
}
