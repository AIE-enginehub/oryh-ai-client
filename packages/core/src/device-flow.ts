import type { ConnectionRegistry, ConnectionSummary } from './connections.js'
import { normalizeOrigin } from './connections.js'
import { decodeIdentity } from './contracts.js'
import type { CredentialPair, CredentialVault } from './credentials.js'
import { OryhClientError } from './errors.js'
import type { Fetcher } from './http.js'
import { OryhHttpClient } from './http.js'

/** Browser approval instructions safe to render in a local client UI. */
export interface DeviceAuthorizationPrompt {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly expiresInSeconds: number
  readonly pollIntervalSeconds: number
}

/** A terminal or pending state from one device-flow poll. */
export type DevicePollOutcome =
  | { readonly state: 'pending'; readonly pollIntervalSeconds: number }
  | { readonly state: 'denied' | 'expired' }
  | { readonly state: 'connected'; readonly connection: ConnectionSummary }

interface DeviceStartData {
  readonly deviceCode: string
  readonly prompt: DeviceAuthorizationPrompt
}

/**
 * Whether the person who approved a connection may have it here: throws to refuse them.
 *
 * A deployment that belongs to one person — the Docker image, whose sign-in gateway lets only its
 * owner in — had this door behind it: once inside, "connect" asks ORYH for a device approval, and ORYH
 * binds that to whoever is signed in to it in the browser. Another account's approval was taken, and
 * the owner's sessions and drafts then ran on that account's ORYH access.
 */
export type ConnectionAdmission = (origin: string, identity: ConnectionSummary['identity']) => Promise<void> | void

/** Begins and completes ORYH's device flow without disclosing issued credentials to callers. */
export class DeviceFlowConnector {
  constructor(
    private readonly connections: ConnectionRegistry,
    private readonly credentials: CredentialVault,
    private readonly fetcher: Fetcher,
    private readonly connected: (connection: ConnectionSummary) => Promise<void> = async () => {},
    private readonly admit: ConnectionAdmission = () => {},
  ) {}

  /** Ask ORYH to create a browser approval request. */
  async begin(origin: string, clientName: string): Promise<DeviceConnectionAttempt> {
    const normalizedOrigin = normalizeOrigin(origin)
    const response = await this.fetcher(`${normalizedOrigin}/api/v1/auth/device/start`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: clientName }),
    })
    const body = await response.json()
    if (!response.ok) {
      throw new OryhClientError('ORYH device authorization could not be started.', 'request-failed', response.status)
    }
    const started = decodeStart(body)
    return new DeviceConnectionAttempt(
      normalizedOrigin,
      started,
      this.connections,
      this.credentials,
      this.fetcher,
      this.connected,
      this.admit,
    )
  }
}

/** One pending browser authorization. Its device code stays private to this Host object. */
export class DeviceConnectionAttempt {
  readonly prompt: DeviceAuthorizationPrompt

  constructor(
    private readonly origin: string,
    private readonly started: DeviceStartData,
    private readonly connections: ConnectionRegistry,
    private readonly credentials: CredentialVault,
    private readonly fetcher: Fetcher,
    private readonly connected: (connection: ConnectionSummary) => Promise<void>,
    private readonly admit: ConnectionAdmission,
  ) {
    this.prompt = started.prompt
  }

  /** Poll exactly once so the UI or DSH Host owns timing and cancellation. */
  async pollOnce(): Promise<DevicePollOutcome> {
    const response = await this.fetcher(`${this.origin}/api/v1/auth/device/token`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: this.started.deviceCode }),
    })
    const body = await response.json()
    if (!response.ok) {
      throw new OryhClientError('ORYH device authorization polling failed.', 'request-failed', response.status)
    }
    const data = responseData(body, 'device authorization')
    const state = data.status
    if (state === 'pending') {
      return { state, pollIntervalSeconds: number(data.interval, 'device poll interval') }
    }
    if (state === 'denied' || state === 'expired') return { state }
    if (state !== 'approved') {
      throw new OryhClientError('ORYH returned an invalid device authorization response.', 'invalid-response')
    }
    const credential = decodeCredential(data)
    const temporary = this.connections.add({
      origin: this.origin,
      identity: temporaryIdentity,
    })
    try {
      await this.credentials.write(temporary.id, credential)
      const client = new OryhHttpClient(this.connections, this.credentials, this.fetcher)
      const identity = decodeIdentity(await client.request(temporary.id, { path: '/auth/me' }))
      // Refused here, the credential just written is removed below with the connection it was for.
      await this.admit(this.origin, identity)
      const existing = this.connections
        .list()
        .filter(
          connection =>
            connection.id !== temporary.id &&
            connection.origin === this.origin &&
            connection.identity.user.id === identity.user.id &&
            connection.identity.tenant.id === identity.tenant.id,
        )
        // Older builds could leave several grants for one identity. Repair the
        // newest one, which is also the workspace's cold-start selection.
        .sort((a, b) => Date.parse(b.connectedAt) - Date.parse(a.connectedAt))[0]
      const id = existing?.id ?? temporary.id
      if (existing) {
        // Re-signing in after a refused legacy migration repairs the existing
        // connection, including its chat bindings, instead of leaving a broken
        // duplicate which would ask for OS access again on the next launch.
        const latest = await this.credentials.read(temporary.id)
        if (!latest) throw new OryhClientError('ORYH sign-in could not be saved.', 'credential-store-failed')
        await this.credentials.write(id, latest)
        await this.credentials.remove(temporary.id)
        this.connections.remove(temporary.id)
      }
      await this.credentials.bindConnection?.({ ...(existing ?? temporary), identity })
      const connection = this.connections.markVerified(id, identity)
      await this.connected(connection)
      return { state: 'connected', connection }
    } catch (error) {
      try {
        await this.credentials.remove(temporary.id)
      } finally {
        this.connections.remove(temporary.id)
      }
      throw error
    }
  }
}

const temporaryIdentity = {
  user: {
    id: 'device-flow-pending',
    email: 'device-flow-pending@invalid',
    name: null,
    role: 'device-flow-pending',
    employeeId: null,
  },
  tenant: {
    id: 'device-flow-pending',
    slug: 'device-flow-pending',
    name: null,
    environmentId: null,
  },
} as const

function responseData(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OryhClientError(`ORYH returned an invalid ${label} response.`, 'invalid-response')
  }
  const data = (value as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new OryhClientError(`ORYH returned an invalid ${label} response.`, 'invalid-response')
  }
  return data as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new OryhClientError(`ORYH returned an invalid ${label}.`, 'invalid-response')
  }
  return value
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OryhClientError(`ORYH returned an invalid ${label}.`, 'invalid-response')
  }
  return value
}

function decodeStart(value: unknown): DeviceStartData {
  const data = responseData(value, 'device authorization start')
  return {
    deviceCode: string(data.device_code, 'device code'),
    prompt: {
      userCode: string(data.user_code, 'device user code'),
      verificationUri: string(data.verification_uri, 'verification URI'),
      verificationUriComplete: string(data.verification_uri_complete, 'verification URI'),
      expiresInSeconds: number(data.expires_in, 'device expiry'),
      pollIntervalSeconds: number(data.interval, 'device poll interval'),
    },
  }
}

function decodeCredential(data: Record<string, unknown>): CredentialPair {
  const expiresAt = data.expires_at
  if (expiresAt !== null && expiresAt !== undefined && typeof expiresAt !== 'string') {
    throw new OryhClientError('ORYH returned an invalid credential expiry.', 'invalid-response')
  }
  return {
    accessKey: string(data.api_key, 'device access key'),
    refreshToken: string(data.refresh_token, 'device refresh token'),
    expiresAt: expiresAt ?? null,
  }
}
