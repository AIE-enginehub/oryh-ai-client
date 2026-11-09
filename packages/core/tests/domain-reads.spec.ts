import { describe, expect, it } from 'vitest'
import { ConnectionRegistry, MemoryConnectionStore, MemoryCredentialVault, OryhClientHost } from '../src/index.js'
import { jsonResponse } from './fixtures.js'

/** A Host with one connection, whose fetcher keeps what was asked of ORYH. */
async function setup() {
  const vault = new MemoryCredentialVault()
  const connection = new ConnectionRegistry().add({
    origin: 'https://oryh.example',
    identity: {
      user: { id: 'u', email: 'u@example.invalid', name: 'U', employeeId: 'e', role: 'member' },
      tenant: { id: 't', slug: 't', name: 'T', environmentId: null },
    },
  })
  await vault.write(connection.id, { accessKey: 'synthetic', refreshToken: 'synthetic', expiresAt: null })
  const asked: { path: string; method: string; body: unknown }[] = []
  const host = new OryhClientHost({
    credentialVault: vault,
    connectionStore: new MemoryConnectionStore([connection]),
    fetcher: async (input, init) => {
      const path = new URL(input).pathname
      asked.push({ path, method: init?.method ?? 'GET', body: init?.body })
      if (path.endsWith('/auth/me'))
        return jsonResponse(200, {
          data: {
            id: 'u',
            email: 'u@example.invalid',
            name: 'U',
            role: 'member',
            employee_id: 'e',
            tenant_id: 't',
            tenant: { id: 't', slug: 't', name: 'T' },
            environment_id: null,
          },
        })
      return jsonResponse(200, { data: [] })
    },
  })
  return { host, id: connection.id, asked }
}

describe('what a domain is given to build its service on', () => {
  it('reads a path as the connection, and passes on nothing but the path', async () => {
    const { host, id, asked } = await setup()
    const reads = host.createDomainReads()
    await reads.verify(id)
    asked.length = 0
    await reads.http.request(id, { path: '/sales-orders?status=draft' })
    expect(asked).toEqual([{ path: '/api/v1/sales-orders', method: 'GET', body: undefined }])
    // A service that asked for more than a read — by mistake, or on purpose — still only reads: the
    // method and the body it named never reach the transport.
    asked.length = 0
    await reads.http.request(id, { path: '/sales-orders', method: 'POST', body: { status: 'approved' } } as never)
    expect(asked).toEqual([{ path: '/api/v1/sales-orders', method: 'GET', body: undefined }])
  })

  it('says who a connection is only once ORYH has, and waits for an asking under way', async () => {
    const { host, id, asked } = await setup()
    const reads = host.createDomainReads()
    // A service's first read as the Host starts: the connection is restored and not yet verified.
    await expect(reads.settled(id)).rejects.toThrow()
    const verifying = reads.verify(id)
    // Asked while that verification is still on its way, it waits for it instead of failing.
    const settled = reads.settled(id)
    expect((await verifying).identity.user.employeeId).toBe('e')
    expect((await settled).identity.user.employeeId).toBe('e')
    expect(reads.current(id).origin).toBe('https://oryh.example')
    expect(asked.filter(request => request.path.endsWith('/auth/me'))).toHaveLength(1)
    expect(() => reads.current('no-such-connection')).toThrow()
  })

  it('gives each service a lookup of its own for what the lists declare', async () => {
    const { host } = await setup()
    const reads = host.createDomainReads()
    expect(reads.lists()).not.toBe(reads.lists())
  })
})
