import { describe, expect, it } from 'vitest'
import { connectionId, MemoryConnectionStore, MemoryCredentialVault, OryhClientHost } from '../src/index.js'
import { jsonResponse, ScriptedFetcher } from './fixtures.js'

describe('OryhClientHost', () => {
  it('owns a device connection and removes its credential on disconnect', async () => {
    const credentials = new MemoryCredentialVault()
    const fetcher = new ScriptedFetcher([
      jsonResponse(201, {
        data: {
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://oryh.example/web/device',
          verification_uri_complete: 'https://oryh.example/web/device?code=ABCD-EFGH',
          expires_in: 900,
          interval: 5,
        },
        meta: {},
      }),
      jsonResponse(200, {
        data: {
          status: 'approved',
          api_key: 'issued-access-key',
          refresh_token: 'issued-refresh-token',
          expires_at: null,
        },
        meta: {},
      }),
      jsonResponse(200, {
        data: {
          id: 'user-1',
          email: 'member@example.com',
          name: null,
          role: 'member',
          employee_id: 'employee-1',
          permissions: ['master_data.manage'],
          tenant_id: 'tenant-1',
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' },
          environment_id: null,
        },
        meta: {},
      }),
    ])
    const host = new OryhClientHost({ credentialVault: credentials, fetcher: fetcher.fetch })

    const attempt = await host.beginDeviceConnection('https://oryh.example', 'ORYH AI Client')
    const outcome = await attempt.pollOnce()
    if (outcome.state !== 'connected') throw new Error('Expected a connected device flow')

    await expect(host.connections()).resolves.toEqual([outcome.connection])
    await host.disconnect(outcome.connection.id)
    await expect(host.connections()).resolves.toEqual([])
    await expect(credentials.read(outcome.connection.id)).resolves.toBeUndefined()
  })

  it('restores only persisted connection metadata with a matching credential entry', async () => {
    const credentials = new MemoryCredentialVault()
    const store = new MemoryConnectionStore([
      {
        id: connectionId('oryh-1'),
        origin: 'https://oryh.example',
        identity: {
          user: { id: 'user-1', email: 'member@example.com', name: 'Member', role: 'member', employeeId: 'employee-1' },
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme', environmentId: null },
        },
        connectedAt: '2026-08-28T00:00:00Z',
      },
    ])
    await credentials.write(connectionId('oryh-1'), {
      accessKey: 'restored-access-key',
      refreshToken: 'restored-refresh-token',
      expiresAt: null,
    })
    const host = new OryhClientHost({
      credentialVault: credentials,
      connectionStore: store,
      fetcher: async () => {
        throw new Error('No network request expected while restoring')
      },
    })

    await expect(host.connections()).resolves.toMatchObject([{ id: 'oryh-1', identity: { tenant: { slug: 'acme' } } }])
  })

  it('drops stale metadata whose matching credential has been removed from the keychain', async () => {
    const store = new MemoryConnectionStore([
      {
        id: connectionId('oryh-1'),
        origin: 'https://oryh.example',
        identity: {
          user: { id: 'user-1', email: 'member@example.com', name: 'Member', role: 'member', employeeId: 'employee-1' },
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme', environmentId: null },
        },
        connectedAt: '2026-08-28T00:00:00Z',
      },
    ])
    const host = new OryhClientHost({
      credentialVault: new MemoryCredentialVault(),
      connectionStore: store,
      fetcher: async () => {
        throw new Error('No network request expected while restoring')
      },
    })

    await expect(host.connections()).resolves.toEqual([])
    await expect(store.load()).resolves.toEqual([])
  })

  it('verifies a restored credential against the same stable ORYH user and tenant before publishing operations', async () => {
    const id = connectionId('oryh-1')
    const credentials = new MemoryCredentialVault()
    await credentials.write(id, {
      accessKey: 'restored-access-key',
      refreshToken: 'restored-refresh-token',
      expiresAt: null,
    })
    const store = new MemoryConnectionStore([
      {
        id,
        origin: 'https://oryh.example',
        identity: {
          user: { id: 'user-1', email: 'member@example.com', name: 'Member', role: 'member', employeeId: 'employee-1' },
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme', environmentId: null },
        },
        connectedAt: '2026-08-28T00:00:00Z',
      },
    ])
    const fetcher = new ScriptedFetcher([
      jsonResponse(200, {
        data: {
          id: 'user-1',
          email: 'member@example.com',
          name: 'Member',
          role: 'manager',
          employee_id: 'employee-1',
          permissions: ['master_data.manage'],
          tenant_id: 'tenant-1',
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' },
          environment_id: null,
        },
        meta: {},
      }),
    ])
    const host = new OryhClientHost({ credentialVault: credentials, connectionStore: store, fetcher: fetcher.fetch })

    await expect(host.verifyConnection(id)).resolves.toMatchObject({ identity: { user: { role: 'manager' } } })
    await expect(store.load()).resolves.toMatchObject([{ identity: { user: { role: 'manager' } } }])
    expect(fetcher.calls[0]?.input).toBe('https://oryh.example/api/v1/auth/me')
  })

  it('rejects a restored connection when the credential resolves to another ORYH user or tenant', async () => {
    const id = connectionId('oryh-1')
    const credentials = new MemoryCredentialVault()
    await credentials.write(id, {
      accessKey: 'restored-access-key',
      refreshToken: 'restored-refresh-token',
      expiresAt: null,
    })
    const store = new MemoryConnectionStore([
      {
        id,
        origin: 'https://oryh.example',
        identity: {
          user: { id: 'user-1', email: 'member@example.com', name: 'Member', role: 'member', employeeId: 'employee-1' },
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme', environmentId: null },
        },
        connectedAt: '2026-08-28T00:00:00Z',
      },
    ])
    const fetcher = new ScriptedFetcher([
      jsonResponse(200, {
        data: {
          id: 'user-2',
          email: 'other@example.com',
          name: 'Other',
          role: 'member',
          employee_id: 'employee-2',
          permissions: ['master_data.manage'],
          tenant_id: 'tenant-1',
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' },
          environment_id: null,
        },
        meta: {},
      }),
    ])
    const host = new OryhClientHost({ credentialVault: credentials, connectionStore: store, fetcher: fetcher.fetch })

    await expect(host.verifyConnection(id)).rejects.toMatchObject({ code: 'connection-identity-mismatch' })
  })
})

function restoredHost(fetcher: import('../src/http.js').Fetcher) {
  const id = connectionId('oryh-1')
  const credentials = new MemoryCredentialVault()
  const identity = {
    permissions: ['master_data.manage'],
    user: { id: 'user-1', email: 'member@example.com', name: null, role: 'member', employeeId: 'employee-1' },
    tenant: { id: 'tenant-1', slug: 'acme', name: null, environmentId: null },
  }
  const store = new MemoryConnectionStore([
    { id, origin: 'https://oryh.example', identity, connectedAt: '2026-08-28T00:00:00Z' },
  ])
  return {
    id,
    credentials,
    store,
    async create() {
      await credentials.write(id, { accessKey: 'synthetic-key', refreshToken: 'synthetic-refresh', expiresAt: null })
      return new OryhClientHost({ credentialVault: credentials, connectionStore: store, fetcher })
    },
  }
}

const verifiedIdentity = {
  data: {
    id: 'user-1',
    email: 'member@example.com',
    role: 'member',
    employee_id: 'employee-1',
    permissions: ['master_data.manage'],
    tenant_id: 'tenant-1',
    tenant: { slug: 'acme' },
  },
}

it('freezes a previously verified connection and clears results after identity verification fails', async () => {
  const fetcher = new ScriptedFetcher([
    jsonResponse(200, verifiedIdentity),
    jsonResponse(200, { data: [], meta: { total: 0 } }),
    jsonResponse(200, { data: { ...verifiedIdentity.data, id: 'different-user' } }),
  ])
  const fixture = restoredHost(fetcher.fetch)
  const host = await fixture.create()
  await host.verifyConnection(fixture.id)
  const cached = await host.executeProjects(fixture.id)
  await expect(host.verifyConnection(fixture.id)).rejects.toMatchObject({ code: 'connection-identity-mismatch' })
  await expect(host.executeProjects(fixture.id)).rejects.toMatchObject({ code: 'connection-verification-required' })
  await expect(host.reuseProjectResult(fixture.id, cached.id)).rejects.toMatchObject({
    code: 'connection-verification-required',
  })
  expect(fetcher.calls).toHaveLength(3)
})

it('rejects a pending result after disconnect and leaves no reusable cached data', async () => {
  let release: (value: ReturnType<typeof jsonResponse>) => void = () => {
    throw new Error('Request not started')
  }
  let started: () => void = () => {}
  const pendingStarted = new Promise<void>(resolve => {
    started = resolve
  })
  let reads = 0
  const fixture = restoredHost(async input => {
    if (input.endsWith('/auth/me')) return jsonResponse(200, verifiedIdentity)
    reads += 1
    if (reads === 1) return jsonResponse(200, { data: [], meta: { total: 0 } })
    return new Promise(resolve => {
      release = resolve
      started()
    })
  })
  const host = await fixture.create()
  await host.verifyConnection(fixture.id)
  const cached = await host.executeProjects(fixture.id)
  const pending = host.executeProjects(fixture.id)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'connection-not-found' })
  await pendingStarted
  await host.disconnect(fixture.id)
  release(jsonResponse(200, { data: [], meta: { total: 0 } }))
  await rejected
  await expect(host.reuseProjectResult(fixture.id, cached.id)).rejects.toMatchObject({ code: 'connection-not-found' })
  await expect(fixture.credentials.read(fixture.id)).resolves.toBeUndefined()
  await expect(fixture.store.load()).resolves.toEqual([])
})

it('does not restore credentials when a token rotation finishes during disconnect', async () => {
  let release: (value: ReturnType<typeof jsonResponse>) => void = () => {
    throw new Error('Refresh not started')
  }
  let started: () => void = () => {}
  const pendingStarted = new Promise<void>(resolve => {
    started = resolve
  })
  const fixture = restoredHost(async input => {
    if (input.endsWith('/auth/me')) return jsonResponse(200, verifiedIdentity)
    if (input.endsWith('/auth/token/refresh'))
      return new Promise(resolve => {
        release = resolve
        started()
      })
    return jsonResponse(401, { detail: 'API key expired' })
  })
  const host = await fixture.create()
  await host.verifyConnection(fixture.id)
  const pending = host.executeProjects(fixture.id)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'connection-not-found' })
  await pendingStarted
  const disconnect = host.disconnect(fixture.id)
  await Promise.resolve()
  release(jsonResponse(200, { data: { api_key: 'rotated', refresh_token: 'rotated-refresh', expires_at: null } }))
  await disconnect
  await rejected
  await expect(fixture.credentials.read(fixture.id)).resolves.toBeUndefined()
})
