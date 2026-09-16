import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { OryhClientError, ipcServerBinding, serveOwnerRequests, type IpcChannel } from '../src/index.js'

/** Two ends of an in-memory IPC link; messages are cloned as Node's IPC would serialize them. */
function link() {
  const a = new EventEmitter(), b = new EventEmitter()
  const end = (self: EventEmitter, other: EventEmitter): IpcChannel & { sent: unknown[] } => {
    const sent: unknown[] = []
    return { sent, send: message => { sent.push(message); queueMicrotask(() => other.emit('message', structuredClone(message))) }, on: (e, l) => self.on(e, l), off: (e, l) => self.off(e, l) }
  }
  return { host: end(a, b), control: end(b, a) }
}
const identity = { user: { id: 'u', email: 'u@example.test', name: null, role: 'member', employeeId: 'e' }, tenant: { id: 't', slug: 't', name: 'T', environmentId: null } }

describe('the owner Host IPC link', () => {
  it('carries a request to the broker and ORYH status and body back', async () => {
    const { host, control } = link()
    const broker = { send: vi.fn(async () => ({ status: 422, body: { detail: 'x' } })) }
    const lifetime = new AbortController()
    serveOwnerRequests(control, broker, lifetime.signal)
    const binding = ipcServerBinding(host, { origin: 'https://oryh.example.test', identity, signal: lifetime.signal })
    await expect(binding.send({ path: '/projects', method: 'GET' }, new AbortController().signal)).resolves.toEqual({ status: 422, body: { detail: 'x' } })
    expect(broker.send).toHaveBeenCalledWith({ path: '/projects', method: 'GET' }, expect.any(AbortSignal))
  })

  it('turns a broker refusal into the same readable error, and hides other failures', async () => {
    const { host, control } = link()
    const lifetime = new AbortController()
    const broker = { send: vi.fn().mockRejectedValueOnce(new OryhClientError('服务器版目前只读', 'request-failed')).mockRejectedValueOnce(new Error('token=secret')) }
    serveOwnerRequests(control, broker, lifetime.signal)
    const binding = ipcServerBinding(host, { origin: 'https://oryh.example.test', identity, signal: lifetime.signal })
    await expect(binding.send({ path: '/x', method: 'POST' }, new AbortController().signal)).rejects.toThrow('服务器版目前只读')
    const hidden = await binding.send({ path: '/x' }, new AbortController().signal).catch(error => error as Error)
    expect(hidden.message).not.toContain('secret')
  })

  it('refuses malformed requests without asking the broker, and cancels in-flight work', async () => {
    const { host, control } = link()
    const lifetime = new AbortController()
    let seen: AbortSignal | undefined
    const broker = { send: vi.fn(async (_r: unknown, signal: AbortSignal) => { seen = signal; return new Promise<never>(() => {}) }) }
    serveOwnerRequests(control, broker, lifetime.signal)
    for (const bad of [{ path: 'http://elsewhere' }, { path: '/x', method: 'PUT' }, { path: '/x', root: 'yes' }, 'nope']) {
      host.send({ type: 'oryh-request', id: 100 + Math.floor(Math.random() * 1000), request: bad })
    }
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(broker.send).not.toHaveBeenCalled()
    expect(host.sent).toHaveLength(4)
    const binding = ipcServerBinding(host, { origin: 'https://oryh.example.test', identity, signal: lifetime.signal })
    const abort = new AbortController()
    const pending = binding.send({ path: '/slow' }, abort.signal)
    await vi.waitFor(() => expect(seen).toBeDefined())
    abort.abort()
    await expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(seen!.aborted).toBe(true))
  })
})

describe('write operations across the link', () => {
  it('carries a well-formed operation to the broker and refuses a malformed one', async () => {
    const { host, control } = link()
    const lifetime = new AbortController()
    const broker = { send: vi.fn(async () => ({ status: 201, body: { data: { id: 'h1' } } })) }
    serveOwnerRequests(control, broker, lifetime.signal)
    const binding = ipcServerBinding(host, { origin: 'https://oryh.example.test', identity, signal: lifetime.signal })
    const operation = { kind: 'chat' as const, operationId: 'op-1', sessionId: 's-1', callId: 'call-1' }
    await binding.send({ path: '/timesheet-headers', method: 'POST', body: { a: 1 }, operation }, new AbortController().signal)
    expect(broker.send).toHaveBeenCalledWith({ path: '/timesheet-headers', method: 'POST', body: { a: 1 }, operation }, expect.any(AbortSignal))
    for (const bad of [{ kind: 'chat', operationId: 'op 2', sessionId: 's', callId: 'c' }, { kind: 'page', operationId: 'op-3', digest: 'nope', confirmedAt: 1 }, { kind: 'agent', operationId: 'op-4' }]) {
      await expect(binding.send({ path: '/timesheet-headers', method: 'POST', operation: bad as never }, new AbortController().signal)).rejects.toThrow('不在服务器版开放的范围内')
    }
    expect(broker.send).toHaveBeenCalledTimes(1)
  })
})
