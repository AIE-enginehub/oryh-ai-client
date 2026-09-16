/**
 * The IPC link between an owner Host process and the control process, for ORYH requests.
 *
 * The owner Host side is a `ServerBinding`: its business runtime sends requests as it would over
 * HTTP, and gets ORYH's status and body back. The control side validates each message's shape before
 * the broker sees it, since the owner Host runs model-driven code and is not trusted to be well-formed.
 */
import type { OryhIdentity } from './contracts.js'
import { OryhClientError } from './errors.js'
import type { DelegatedResponse, OryhRequest } from './http.js'
import type { ServerBinding } from './server-read.js'
import type { OryhOperation } from './server-operation.js'

/** The part of a Node IPC channel this link uses: a child process, or `process` inside the child. */
export interface IpcChannel {
  send(message: unknown): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
}

type Outgoing = { type: 'oryh-request'; id: number; request: OryhRequest } | { type: 'oryh-cancel'; id: number }
type Incoming = { type: 'oryh-response'; id: number; status: number; body: unknown } | { type: 'oryh-refused'; id: number; message: string; code: string }

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])
const MAX_BODY_BYTES = 1_000_000
const REQUEST_TIMEOUT_MS = 60_000

/**
 * The owner Host's binding: every ORYH request goes to the control process.
 * @param channel - `process` in the owner Host.
 * @param config - the signed-in person, as the control process told this Host at startup.
 * @returns a binding for `createServerOryhRuntime`, and a disposer for its listener.
 */
export function ipcServerBinding(channel: IpcChannel, config: { origin: string; identity: OryhIdentity; signal: AbortSignal }): ServerBinding & { dispose(): void } {
  const pending = new Map<number, { resolve(answer: DelegatedResponse): void; reject(error: Error): void }>()
  let next = 1
  const listener = (raw: unknown) => {
    const message = raw as Incoming
    const waiter = typeof message?.id === 'number' ? pending.get(message.id) : undefined
    if (!waiter) return
    pending.delete(message.id)
    if (message.type === 'oryh-response') waiter.resolve({ status: message.status, body: message.body })
    else if (message.type === 'oryh-refused') waiter.reject(new OryhClientError(String(message.message), 'request-failed'))
  }
  channel.on('message', listener)
  const closed = () => { for (const waiter of pending.values()) waiter.reject(new Error('owner Host link closed')); pending.clear() }
  config.signal.addEventListener('abort', closed, { once: true })
  return {
    origin: config.origin,
    identity: config.identity,
    signal: config.signal,
    send(request, signal) {
      const id = next++
      return new Promise<DelegatedResponse>((resolve, reject) => {
        const combined = AbortSignal.any([signal, config.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        if (combined.aborted) { reject(new Error('cancelled')); return }
        const cancel = () => { if (pending.delete(id)) { channel.send({ type: 'oryh-cancel', id } satisfies Outgoing); reject(new Error('cancelled')) } }
        combined.addEventListener('abort', cancel, { once: true })
        pending.set(id, {
          resolve: answer => { combined.removeEventListener('abort', cancel); resolve(answer) },
          reject: error => { combined.removeEventListener('abort', cancel); reject(error) },
        })
        channel.send({ type: 'oryh-request', id, request: { path: request.path, ...request.root ? { root: true } : {}, ...request.method ? { method: request.method } : {}, ...request.body === undefined ? {} : { body: request.body }, ...request.operation ? { operation: request.operation } : {} } } satisfies Outgoing)
      })
    },
    dispose() { channel.off('message', listener); config.signal.removeEventListener('abort', closed); closed() },
  }
}

/**
 * The control process's end: answer an owner Host's ORYH requests through a broker.
 * @param channel - the owner Host child process.
 * @param broker - decides and sends; see `OwnerBroker`.
 * @param signal - this Host generation's lifetime; ends every in-flight request.
 * @returns a disposer for the listener.
 */
export function serveOwnerRequests(channel: IpcChannel, broker: { send(request: OryhRequest, signal: AbortSignal): Promise<DelegatedResponse> }, signal: AbortSignal): () => void {
  const inFlight = new Map<number, AbortController>()
  const listener = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type === 'oryh-cancel' && typeof message.id === 'number') { inFlight.get(message.id)?.abort(); inFlight.delete(message.id); return }
    if (message.type !== 'oryh-request' || !Number.isSafeInteger(message.id) || inFlight.has(message.id as number)) return
    const id = message.id as number
    const reply = (answer: Incoming) => { if (!signal.aborted) channel.send(answer) }
    let request: OryhRequest
    try { request = validRequest(message.request) } catch {
      reply({ type: 'oryh-refused', id, message: '这个请求不在服务器版开放的范围内。', code: 'request-failed' }); return
    }
    const abort = new AbortController()
    inFlight.set(id, abort)
    void broker.send(request, AbortSignal.any([abort.signal, signal])).then(
      answer => reply({ type: 'oryh-response', id, status: answer.status, body: answer.body }),
      error => reply({ type: 'oryh-refused', id, message: error instanceof OryhClientError ? error.message : '暂时无法完成 ORYH 请求，请稍后重试。', code: 'request-failed' }),
    ).finally(() => inFlight.delete(id))
  }
  channel.on('message', listener)
  const stop = () => { for (const abort of inFlight.values()) abort.abort(); inFlight.clear() }
  signal.addEventListener('abort', stop, { once: true })
  return () => { channel.off('message', listener); signal.removeEventListener('abort', stop); stop() }
}

function validRequest(value: unknown): OryhRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
  const { path, root, method, body, operation } = value as Record<string, unknown>
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096) throw new Error('invalid')
  if (root !== undefined && typeof root !== 'boolean') throw new Error('invalid')
  if (method !== undefined && (typeof method !== 'string' || !METHODS.has(method))) throw new Error('invalid')
  if (body !== undefined && JSON.stringify(body).length > MAX_BODY_BYTES) throw new Error('invalid')
  const request: { -readonly [K in keyof OryhRequest]: OryhRequest[K] } = { path: path as `/${string}` }
  if (root) request.root = true
  if (method) request.method = method as NonNullable<OryhRequest['method']>
  if (body !== undefined) request.body = body
  if (operation !== undefined) request.operation = validOperation(operation)
  return request
}

/** What the control process tells an owner Host when it starts: who is signed in, and its store secret. */
export interface OwnerHostConfig {
  readonly origin: string
  readonly identity: OryhIdentity
  /** Base64 of 32 bytes; this owner's draft-encryption secret. */
  readonly storeSecret: string
  readonly capabilities: { readonly shell: boolean; readonly writes: boolean }
}

/**
 * Ask the control process for this owner Host's configuration.
 *
 * Asked rather than pushed: a message that arrives before the Host has a listener is dropped, and the
 * Host only listens once its plugin loads.
 * @param channel - `process` in the owner Host.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the configuration the control process sent.
 */
export function requestOwnerHostConfig(channel: IpcChannel, timeoutMs = 20_000): Promise<OwnerHostConfig> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { channel.off('message', listener); reject(new Error('owner Host configuration did not arrive')) }, timeoutMs)
    const listener = (raw: unknown) => {
      const message = raw as { type?: string; config?: OwnerHostConfig }
      if (message?.type !== 'oryh-host-config' || !message.config) return
      clearTimeout(timer)
      channel.off('message', listener)
      resolve(message.config)
    }
    channel.on('message', listener)
    channel.send({ type: 'oryh-host-config-request' })
  })
}

/**
 * The control process's answer to an owner Host's configuration request.
 * @param channel - the owner Host child process.
 * @param config - fixed for this Host generation.
 * @returns a disposer for the listener.
 */
export function answerOwnerHostConfig(channel: IpcChannel, config: OwnerHostConfig): () => void {
  const listener = (raw: unknown) => {
    if ((raw as { type?: string })?.type === 'oryh-host-config-request') channel.send({ type: 'oryh-host-config', config })
  }
  channel.on('message', listener)
  return () => channel.off('message', listener)
}

const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** An operation description as the Host sent it, checked field by field; anything else is refused. */
function validOperation(value: unknown): OryhOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
  const o = value as Record<string, unknown>
  if (typeof o.operationId !== 'string' || !OPERATION_ID.test(o.operationId)) throw new Error('invalid')
  if (o.kind === 'page') {
    if (typeof o.digest !== 'string' || !/^[a-f0-9]{64}$/.test(o.digest) || !Number.isSafeInteger(o.confirmedAt)) throw new Error('invalid')
    return { kind: 'page', operationId: o.operationId, digest: o.digest, confirmedAt: o.confirmedAt as number }
  }
  if (o.kind === 'chat') {
    for (const field of [o.sessionId, o.callId]) if (typeof field !== 'string' || !field || field.length > 200) throw new Error('invalid')
    return { kind: 'chat', operationId: o.operationId, sessionId: o.sessionId as string, callId: o.callId as string }
  }
  throw new Error('invalid')
}
