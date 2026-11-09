import type { ConnectionId } from './brand.js'
import type { ConnectionRegistry } from './connections.js'
import type { CredentialPair, CredentialVault } from './credentials.js'
import { OryhClientError } from './errors.js'
import { idempotencyHeaders, type OryhOperation } from './server-operation.js'

/** A minimal fetch response seam, small enough to replace in tests or DSH Host adapters. */
export interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** A minimal fetch seam, injected by the Host rather than read globally. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<FetchResponse>

/** A request constrained to ORYH's versioned API paths, or to its MCP endpoint at the deployment root. */
export interface OryhRequest {
  readonly path: `/${string}`
  /** Address `path` from the deployment root instead of `/api/v1` — where ORYH mounts `/mcp`. */
  readonly root?: boolean
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly body?: unknown
  /** Disable replay for business writes whose outcome must be reconciled explicitly. */
  readonly retryExpired?: boolean
  /** On the server: how this write was confirmed, for the control process to admit and record it. */
  readonly operation?: OryhOperation
  /**
   * This one call's cancellation — the tool call or turn it belongs to was stopped. Never sent: it ends
   * the request here, beside the connection's lifetime and the timeout, and nothing is sent after it fires.
   */
  readonly signal?: AbortSignal
}

/** Host-local timings that govern when an interactive credential is refreshed. */
export interface OryhHttpClientOptions {
  /** Clock used for the expiry check; injectable so the decision has deterministic coverage. */
  readonly clock?: () => Date
  /** Refresh an access key this many milliseconds before its server-provided expiry. */
  readonly refreshAheadMs?: number
  /** Trusted server adapter; owns authentication outside this business Host. Never a model argument. */
  readonly delegated?: DelegatedTransport
}

/** What ORYH answered to one brokered request: its status and parsed JSON body. */
export interface DelegatedResponse {
  readonly status: number
  readonly body: unknown
}

/**
 * A transport that authenticates somewhere else — the server's control process, which holds the
 * person's grant. It answers ORYH's own status so domain errors (409, 422) read as they do locally;
 * it throws an `OryhClientError` when it refuses a request itself, with a message meant for people.
 */
export interface DelegatedTransport {
  readonly signal: AbortSignal
  send(request: OryhRequest, signal: AbortSignal): Promise<DelegatedResponse>
}

interface ErrorBody {
  readonly detail?: unknown
}

/** Where ORYH mounts its versioned API; also the prefix its OpenAPI document uses for path keys. */
export const API_PREFIX = '/api/v1'

function apiPath(origin: string, path: string): string {
  return `${origin}${API_PREFIX}${path}`
}

function errorDetail(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const detail = (value as ErrorBody).detail
  return typeof detail === 'string' ? detail : undefined
}

function expiredKey(response: FetchResponse, body: unknown): boolean {
  return response.status === 401 && errorDetail(body)?.includes('API key expired') === true
}

function asCredential(value: unknown): CredentialPair {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OryhClientError('ORYH returned an invalid refresh response.', 'invalid-response')
  }
  const data = (value as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new OryhClientError('ORYH returned an invalid refresh response.', 'invalid-response')
  }
  const fields = data as Record<string, unknown>
  if (typeof fields.api_key !== 'string' || typeof fields.refresh_token !== 'string') {
    throw new OryhClientError('ORYH returned an invalid refresh response.', 'invalid-response')
  }
  const expiresAt = fields.expires_at
  if (expiresAt !== null && expiresAt !== undefined && typeof expiresAt !== 'string') {
    throw new OryhClientError('ORYH returned an invalid refresh response.', 'invalid-response')
  }
  const credential = {
    accessKey: fields.api_key,
    refreshToken: fields.refresh_token,
    expiresAt: expiresAt ?? null,
  }
  if (credential.expiresAt !== null && !Number.isFinite(Date.parse(credential.expiresAt))) {
    throw new OryhClientError('ORYH returned an invalid refresh response.', 'invalid-response')
  }
  return credential
}

const DEFAULT_REFRESH_AHEAD_MS = 60_000

/** Host-only HTTP adapter that injects credentials, refreshes once, and never returns them. */
export class OryhHttpClient {
  readonly #closed = new Set<ConnectionId>()
  readonly #requests = new Map<ConnectionId, AbortController>()
  readonly #clock: () => Date
  readonly #refreshAheadMs: number
  readonly #refreshes = new Map<ConnectionId, Promise<CredentialPair>>()

  constructor(
    private readonly connections: ConnectionRegistry,
    private readonly credentials: CredentialVault,
    private readonly fetcher: Fetcher,
    private readonly options: OryhHttpClientOptions = {},
  ) {
    this.#clock = options.clock ?? (() => new Date())
    this.#refreshAheadMs = refreshAheadMs(options.refreshAheadMs)
  }

  /** Call a versioned ORYH API endpoint inside one existing connection scope. */
  async request(connectionId: ConnectionId, request: OryhRequest): Promise<unknown> {
    return (await this.exchange(connectionId, request)).body
  }

  /**
   * The same call, answering ORYH's success status beside the body, for the endpoints whose status says
   * something of its own: an upload answers 200 when it already held these bytes and 201 when it did not.
   */
  async exchange(connectionId: ConnectionId, request: OryhRequest): Promise<DelegatedResponse> {
    request.signal?.throwIfAborted()
    this.assertOpen(connectionId)
    if (this.options.delegated) {
      const answer = await this.delegate(connectionId, request)
      if (answer.status >= 200 && answer.status < 300) return answer
      throw requestError({ ok: false, status: answer.status, json: async () => answer.body }, answer.body, request.path)
    }
    const connection = this.connections.require(connectionId)
    let credential = await this.requireCredential(connectionId)
    if (shouldRefresh(credential, this.#clock(), this.#refreshAheadMs)) {
      credential = await this.refreshCredential(connectionId, connection.origin, credential)
    }
    this.assertOpen(connectionId)
    // Reading or refreshing the credential took time; a call stopped meanwhile sends nothing.
    request.signal?.throwIfAborted()
    const first = await this.send(connectionId, connection.origin, request, credential.accessKey)
    const firstBody = await bodyOf(first)
    this.assertOpen(connectionId)
    if (first.ok) return { status: first.status, body: firstBody }
    if (!expiredKey(first, firstBody) || request.retryExpired === false)
      throw requestError(first, firstBody, request.path)

    const refreshed = await this.refreshCredential(connectionId, connection.origin, credential)
    this.assertOpen(connectionId)
    request.signal?.throwIfAborted()
    const second = await this.send(connectionId, connection.origin, request, refreshed.accessKey)
    const secondBody = await bodyOf(second)
    this.assertOpen(connectionId)
    if (second.ok) return { status: second.status, body: secondBody }
    throw requestError(second, secondBody, request.path)
  }

  /**
   * Send one request through the delegated transport, bounded by this connection's lifetime.
   * A refusal the transport explains is passed on; any other failure is reported without its detail,
   * which could carry transport internals.
   */
  private async delegate(connectionId: ConnectionId, request: OryhRequest): Promise<DelegatedResponse> {
    const delegated = this.options.delegated!
    const signal = this.callSignal(connectionId, request, delegated.signal)
    let answer: DelegatedResponse
    try {
      answer = await delegated.send(request, signal)
    } catch (error) {
      // Stopped by its own caller: that is what it reports, not a failed request.
      request.signal?.throwIfAborted()
      if (error instanceof OryhClientError && !signal.aborted) throw error
      throw new OryhClientError('Server business request failed or authorization ended.', 'request-failed')
    }
    signal.throwIfAborted()
    this.assertOpen(connectionId)
    return answer
  }

  /** Wait for an existing refresh to stop before deleting its credential entry. */
  async close(connectionId: ConnectionId): Promise<void> {
    this.#closed.add(connectionId)
    this.#requests.get(connectionId)?.abort()
    this.#requests.delete(connectionId)
    await this.#refreshes.get(connectionId)?.catch(() => {
      // A disconnected connection may cause its pending rotation to fail.
    })
  }

  /** Reject disconnected requests, including a late identity verification. */
  assertOpen(connectionId: ConnectionId): void {
    this.connections.require(connectionId)
    if (this.options.delegated?.signal.aborted || this.#closed.has(connectionId)) {
      throw new OryhClientError('The ORYH connection is closed.', 'connection-not-found')
    }
  }

  private requestSignal(connectionId: ConnectionId): AbortSignal {
    this.assertOpen(connectionId)
    let controller = this.#requests.get(connectionId)
    if (controller === undefined) {
      controller = new AbortController()
      this.#requests.set(connectionId, controller)
    }
    return AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
  }

  /** A request's whole lifetime: its connection's, the timeout, and the call's own when it has one. */
  private callSignal(connectionId: ConnectionId, request: OryhRequest, ...others: AbortSignal[]): AbortSignal {
    return AbortSignal.any([this.requestSignal(connectionId), ...others, ...(request.signal ? [request.signal] : [])])
  }

  /** Read one whole credential bundle or fail before a request exposes an absent connection. */
  private async requireCredential(connectionId: ConnectionId, fresh = false): Promise<CredentialPair> {
    const credential = await (fresh && this.credentials.readFresh
      ? this.credentials.readFresh(connectionId)
      : this.credentials.read(connectionId))
    if (credential === undefined) {
      throw new OryhClientError('The ORYH connection has no credential.', 'authentication-failed')
    }
    return credential
  }

  /**
   * Rotate a connection's credential at most once at a time.
   * A waiter observes the completed keychain write before it can retry, and a
   * request that already sees another caller's newer bundle never rotates the
   * stale refresh token a second time.
   */
  private async refreshCredential(
    connectionId: ConnectionId,
    origin: string,
    observed: CredentialPair,
  ): Promise<CredentialPair> {
    const active = this.#refreshes.get(connectionId)
    if (active !== undefined) return active

    const refresh = (async () => {
      const current = await this.requireCredential(connectionId, true)
      if (!sameCredential(current, observed)) return current
      const refreshed = await this.refresh(connectionId, origin, current.refreshToken)
      this.assertOpen(connectionId)
      await this.credentials.write(connectionId, refreshed)
      return refreshed
    })()
    this.#refreshes.set(connectionId, refresh)
    try {
      return await refresh
    } finally {
      if (this.#refreshes.get(connectionId) === refresh) this.#refreshes.delete(connectionId)
    }
  }

  /**
   * ORYH's own OpenAPI document, which says what each list endpoint accepts.
   *
   * It is served at the application root rather than under the API prefix, and it is public, so
   * it is fetched WITHOUT the access key: the key authorizes business API calls and has no reason
   * to travel to anything else.
   * @param connectionId - verified connection whose deployment to describe.
   * @returns the parsed OpenAPI document.
   */
  async schema(connectionId: ConnectionId): Promise<unknown> {
    if (this.options.delegated) {
      const answer = await this.delegate(connectionId, { path: '/openapi.json', root: true })
      if (answer.status !== 200)
        throw new OryhClientError(`ORYH did not serve its API schema (HTTP ${answer.status}).`, 'invalid-response')
      return answer.body
    }
    this.assertOpen(connectionId)
    const connection = this.connections.require(connectionId)
    const response = await this.fetcher(`${connection.origin}/openapi.json`, {
      signal: this.requestSignal(connectionId),
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok)
      throw new OryhClientError(`ORYH did not serve its API schema (HTTP ${response.status}).`, 'invalid-response')
    return response.json()
  }

  private async send(
    connectionId: ConnectionId,
    origin: string,
    request: OryhRequest,
    accessKey: string,
  ): Promise<FetchResponse> {
    return this.fetcher(request.root ? `${origin}${request.path}` : apiPath(origin, request.path), {
      signal: this.callSignal(connectionId, request),
      method: request.method ?? 'GET',
      redirect: 'error',
      headers: {
        'X-API-Key': accessKey,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...idempotencyHeaders(request.operation),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })
  }

  private async refresh(connectionId: ConnectionId, origin: string, refreshToken: string): Promise<CredentialPair> {
    const response = await this.fetcher(apiPath(origin, '/auth/token/refresh'), {
      signal: this.requestSignal(connectionId),
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    // The status says what happened; a failed refresh may answer with HTML or no body at all, and parsing
    // that first turned a plain 502 into a SyntaxError the caller could not explain.
    if (!response.ok) {
      throw new OryhClientError('ORYH credential refresh failed.', 'refresh-failed', response.status)
    }
    return asCredential(await response.json())
  }
}

/** Whether the server-provided access expiry falls within this connection's refresh window. */
function shouldRefresh(credential: CredentialPair, now: Date, refreshAheadMs: number): boolean {
  if (credential.expiresAt === null) return false
  const expiresAt = Date.parse(credential.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime() + refreshAheadMs
}

/** Compare complete credential generations without ever exposing either value to a caller. */
function sameCredential(left: CredentialPair, right: CredentialPair): boolean {
  return (
    left.accessKey === right.accessKey && left.refreshToken === right.refreshToken && left.expiresAt === right.expiresAt
  )
}

/** Normalize one host-owned refresh lead time before network work begins. */
function refreshAheadMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_REFRESH_AHEAD_MS
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError('ORYH refreshAheadMs must be a non-negative safe integer')
  }
  return resolved
}

/**
 * What ORYH answered. A proxy in front of a stopped ORYH answers with its own HTML page; parsed as JSON it
 * surfaced as "Unexpected token '<'", which read to the agent as a broken tool rather than ORYH being down.
 */
async function bodyOf(response: FetchResponse): Promise<unknown> {
  if (response.status === 204 || response.status === 413) return {}
  try {
    return await response.json()
  } catch {
    throw response.ok
      ? new OryhClientError('ORYH 返回了无法识别的内容。', 'invalid-response', response.status)
      : unavailable(response.status)
  }
}

/** ORYH, or the proxy in front of it, could not answer at all: nothing about the request itself. */
const unavailable = (status: number) =>
  new OryhClientError(`ORYH 服务暂时不可用（HTTP ${status}），请稍后重试。`, 'request-failed', status)

function requestError(response: FetchResponse, body: unknown, path?: string): OryhClientError {
  if (response.status === 413 && path === '/attachments')
    return new OryhClientError(
      '附件上传被服务端或网关拒绝（HTTP 413：请求体过大）。原文件允许最大 10 MB；文件未超限时，请联系管理员检查上传链路限制。',
      'request-failed',
      413,
    )
  if (response.status === 502 || response.status === 503 || response.status === 504) return unavailable(response.status)
  // ORYH's refusal is now the only thing between a person and a list they may not read — this client keeps
  // no entry rules of its own — so it is said in words a person can act on. Server detail is still not
  // echoed: it is untrusted response data.
  if (response.status === 403)
    return new OryhClientError(
      'ORYH 没有允许当前账号读取或办理这项内容（HTTP 403）。权限由 ORYH 的管理员设置。',
      'request-failed',
      403,
    )
  return new OryhClientError(
    // Server detail may be useful to a person but is untrusted response data;
    // never promote it into a broadly logged local error where a proxy or
    // future server implementation could have echoed credential material.
    `ORYH request failed with status ${response.status}.`,
    response.status === 401 ? 'authentication-failed' : 'request-failed',
    response.status,
  )
}
