import { describe, expect, it } from 'vitest'
import {
  connectionId,
  type DelegatedResponse,
  MemoryConnectionStore,
  MemoryCredentialVault,
  OryhClientController,
  OryhClientHost,
  type OryhRequest,
} from '../src/index.js'

const identity = {
  user: { id: 'user-a', email: 'a@example.test', name: null, role: 'member', employeeId: 'employee-a' },
  tenant: { id: 'tenant-a', slug: 'a', name: 'A', environmentId: null },
}
const me = {
  data: {
    id: 'user-a',
    email: 'a@example.test',
    role: 'member',
    employee_id: 'employee-a',
    tenant_id: 'tenant-a',
    tenant: { slug: 'a', name: 'A' },
  },
}
const verified: DelegatedResponse = { status: 200, body: me }
const unavailable: DelegatedResponse = { status: 503, body: {} }
const id = connectionId('oryh-1')

function boundHost(answer: (request: OryhRequest) => Promise<DelegatedResponse> | DelegatedResponse) {
  const lifetime = new AbortController()
  const paths: string[] = []
  const host = new OryhClientHost({
    credentialVault: new MemoryCredentialVault(),
    fetcher: async () => {
      throw new Error('Delegated connections must not use the desktop transport')
    },
    serverBinding: {
      origin: 'https://oryh.example.test',
      identity,
      signal: lifetime.signal,
      send: async request => {
        paths.push(request.path)
        return answer(request)
      },
    },
  })
  return { host, controller: new OryhClientController(host), lifetime, paths }
}

describe('Host initialization recovery', () => {
  it('can recover from an eager transport failure before any caller starts waiting', async () => {
    let attempts = 0
    const f = boundHost(() => {
      if (++attempts === 1) throw new Error('Transient transport failure')
      return verified
    })
    // Let the eager initialization reject with no API caller attached. Vitest also checks that
    // this does not become an unhandled rejection that could terminate a production Host.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(attempts).toBe(1)
    await expect(f.controller.listConnections()).resolves.toMatchObject([{ id, identity }])
    expect(attempts).toBe(2)
  })

  it('recovers in the same Host after repeated failures and then reads business data', async () => {
    let attempts = 0
    const f = boundHost(request => {
      if (request.path === '/auth/me') return ++attempts <= 2 ? unavailable : verified
      return { status: 200, body: { data: [], meta: { total: 0, page: 1, size: 100, pages: 0 } } }
    })
    await expect(f.controller.listConnections()).rejects.toMatchObject({ code: 'request-failed' })
    await expect(f.controller.execute(id, 'my-open-todos')).rejects.toMatchObject({ code: 'request-failed' })
    expect(f.paths).toEqual(['/auth/me', '/auth/me'])
    expect(() => f.host.createDomainReads().current(id)).toThrow('not been verified')

    // Retrying a business request also recovers, without a new Host or a different connection ID.
    await expect(f.controller.execute(id, 'my-open-todos')).resolves.toMatchObject({ result: { data: [] } })
    await expect(f.controller.listConnections()).resolves.toMatchObject([{ id }])
    expect(await f.controller.listConnections()).toHaveLength(1)
    expect(attempts).toBe(3)
    expect(f.paths.at(-1)).toContain('/todos?')
  })

  it('shares one pending retry among concurrent callers', async () => {
    let finish!: (response: DelegatedResponse) => void
    const retry = new Promise<DelegatedResponse>(resolve => {
      finish = resolve
    })
    let attempts = 0
    const f = boundHost(() => (++attempts === 1 ? unavailable : retry))
    await expect(f.controller.listConnections()).rejects.toThrow()
    const first = f.controller.listConnections()
    const second = f.controller.listConnections()
    const connection = f.host.connection(id)
    expect(attempts).toBe(2)
    expect(() => f.host.createDomainReads().current(id)).toThrow('not been verified')
    finish(verified)
    const [a, b, c] = await Promise.all([first, second, connection])
    expect(a).toEqual(b)
    expect(a).toEqual([c])
    expect(a).toHaveLength(1)
    await f.controller.listConnections()
    expect(attempts).toBe(2)
  })

  it.each([{ id: 'another-user' }, { tenant_id: 'another-tenant' }])(
    'does not accept a changed identity on retry: %j',
    async changed => {
      let attempts = 0
      const f = boundHost(() => {
        attempts++
        if (attempts === 1) return unavailable
        if (attempts === 2) return { status: 200, body: { data: { ...me.data, ...changed } } }
        return verified
      })
      await expect(f.controller.listConnections()).rejects.toThrow()
      await expect(f.controller.listConnections()).rejects.toMatchObject({ code: 'connection-identity-mismatch' })
      expect(() => f.host.createDomainReads().current(id)).toThrow('not been verified')
      await expect(f.controller.listConnections()).resolves.toMatchObject([{ id, identity }])
      expect(await f.controller.listConnections()).toHaveLength(1)
    },
  )

  it('does not restore access when the delegated authorization ends after a failed start', async () => {
    const f = boundHost(() => unavailable)
    await expect(f.controller.listConnections()).rejects.toThrow()
    f.lifetime.abort()
    await expect(f.controller.listConnections()).rejects.toThrow()
    await expect(f.controller.execute(id, 'my-open-todos')).rejects.toThrow()
    expect(f.paths).toEqual(['/auth/me'])
    expect(() => f.host.createDomainReads().current(id)).toThrow('not been verified')
  })

  it('retries a failed desktop metadata load without losing persisted connections', async () => {
    const connection = { id, identity, origin: 'https://oryh.example.test', connectedAt: '2026-10-27T00:00:00Z' }
    const store = new MemoryConnectionStore([connection])
    let loads = 0
    const vault = new MemoryCredentialVault()
    await vault.write(id, { accessKey: 'test-key', refreshToken: 'test-refresh', expiresAt: null })
    const host = new OryhClientHost({
      credentialVault: vault,
      connectionStore: {
        load: async () => {
          if (++loads === 1) throw new Error('Temporary store failure')
          return store.load()
        },
        save: entries => store.save(entries),
      },
      fetcher: async () => {
        throw new Error('Restoring desktop metadata needs no network')
      },
    })
    await expect(host.connections()).rejects.toThrow('Temporary store failure')
    await expect(host.connections()).resolves.toEqual([connection])
    await expect(store.load()).resolves.toEqual([connection])
    expect(loads).toBe(2)
  })
})
