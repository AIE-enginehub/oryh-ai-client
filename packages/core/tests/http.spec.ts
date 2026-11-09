import { describe, expect, it } from 'vitest'
import {
  ConnectionRegistry,
  KeychainCredentialVault,
  MemoryCredentialVault,
  OryhHttpClient,
  pageOperation,
} from '../src/index.js'
import { header, jsonResponse, ScriptedFetcher } from './fixtures.js'

function identity() {
  return {
    user: {
      id: 'user-1',
      email: 'member@example.com',
      name: 'Member',
      role: 'member',
      employeeId: 'employee-1',
    },
    tenant: {
      id: 'tenant-1',
      slug: 'acme',
      name: 'Acme',
      environmentId: 'production',
    },
  }
}

describe('OryhHttpClient', () => {
  it('reconciles a cached native credential before rotating, preserving another Host’s newer refresh token', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    let stored: string | null = JSON.stringify({ accessKey: 'expired', refreshToken: 'old-r', expiresAt: null })
    let reads = 0
    const credentials = new KeychainCredentialVault({
      entryFactory: () => ({
        getPassword: () => {
          reads += 1
          return stored
        },
        setPassword: value => {
          stored = value
        },
        deleteCredential: () => {
          stored = null
          return true
        },
      }),
    })
    await credentials.read(connection.id)
    // Another Host rotated the persisted pair after this Host loaded its snapshot.
    stored = JSON.stringify({ accessKey: 'fresh', refreshToken: 'new-r', expiresAt: null })
    const fetcher = new ScriptedFetcher([
      jsonResponse(401, { detail: 'API key expired' }),
      jsonResponse(200, { data: [] }),
    ])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch)
    await expect(client.request(connection.id, { path: '/projects' })).resolves.toEqual({ data: [] })
    expect(fetcher.calls.map(call => call.input)).toEqual([
      'https://oryh.example/api/v1/projects',
      'https://oryh.example/api/v1/projects',
    ])
    expect(header(fetcher.calls[1]!.init, 'X-API-Key')).toBe('fresh')
    expect(reads).toBe(2)
  })

  it("sends a confirmed write under ORYH's idempotency key, and a read without one", async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh', expiresAt: null })
    const fetcher = new ScriptedFetcher([jsonResponse(200, { data: {} }), jsonResponse(200, { data: [] })])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch)

    const write = { method: 'POST' as const, path: '/projects' as const, body: { name: 'A' } }
    await client.request(connection.id, {
      ...write,
      operation: pageOperation('op-1', write, text => `sha-${text.length}`),
    })
    await client.request(connection.id, { path: '/projects' })

    expect(header(fetcher.calls[0]!.init, 'idempotency-key')).toBe('op-1')
    expect(header(fetcher.calls[1]!.init, 'idempotency-key')).toBeUndefined()
  })

  it('sends nothing for a call already stopped, and ends one in flight with its own signal', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh', expiresAt: null })
    const fetcher = new ScriptedFetcher([jsonResponse(200, { data: {} })])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch)

    const stopped = new AbortController()
    stopped.abort()
    const write = { method: 'POST' as const, path: '/projects' as const, body: { name: 'A' } }
    await expect(client.request(connection.id, { ...write, signal: stopped.signal })).rejects.toThrow()
    expect(fetcher.calls).toHaveLength(0)

    const live = new AbortController()
    await client.request(connection.id, { ...write, signal: live.signal })
    const sent = fetcher.calls[0]!.init.signal as AbortSignal
    expect(sent.aborted).toBe(false)
    live.abort()
    expect(sent.aborted).toBe(true)
  })

  it("tells a person ORYH refused them in words they can act on, without echoing ORYH's own", async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh', expiresAt: null })
    const fetcher = new ScriptedFetcher([jsonResponse(403, { detail: 'missing verb inventory.manage for key ak_123' })])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch)
    // This is what stands between a person and a list ORYH does not let them read: no rule of this client's does.
    const refused = client.request(connection.id, { path: '/inventory-items' })
    await expect(refused).rejects.toMatchObject({ code: 'request-failed', status: 403 })
    await expect(refused).rejects.toThrow('ORYH 没有允许当前账号读取或办理这项内容')
    await expect(refused).rejects.not.toThrow(/ak_123|inventory\.manage/)
  })

  it('refreshes an expired interactive key exactly once before retrying the request', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, {
      accessKey: 'expired-access-key',
      refreshToken: 'refresh-token',
      expiresAt: null,
    })
    const fetcher = new ScriptedFetcher([
      jsonResponse(401, { detail: 'API key expired — POST /auth/token/refresh' }),
      jsonResponse(200, {
        data: { api_key: 'fresh-access-key', refresh_token: 'fresh-refresh-token', expires_at: null },
        meta: {},
      }),
      jsonResponse(200, { data: [], meta: { total: 0 } }),
    ])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch)

    await expect(client.request(connection.id, { path: '/projects' })).resolves.toEqual({
      data: [],
      meta: { total: 0 },
    })

    expect(fetcher.calls.map(call => call.input)).toEqual([
      'https://oryh.example/api/v1/projects',
      'https://oryh.example/api/v1/auth/token/refresh',
      'https://oryh.example/api/v1/projects',
    ])
    expect(header(fetcher.calls[0]?.init, 'X-API-Key')).toBe('expired-access-key')
    expect(header(fetcher.calls[1]?.init, 'X-API-Key')).toBeUndefined()
    expect(header(fetcher.calls[2]?.init, 'X-API-Key')).toBe('fresh-access-key')
    await expect(credentials.read(connection.id)).resolves.toEqual({
      accessKey: 'fresh-access-key',
      refreshToken: 'fresh-refresh-token',
      expiresAt: null,
    })
  })

  it('reports a failed refresh by status before parsing a non-JSON body', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, {
      accessKey: 'expired-access-key',
      refreshToken: 'refresh-token',
      expiresAt: null,
    })
    const fetcher = new ScriptedFetcher([
      jsonResponse(401, { detail: 'API key expired — POST /auth/token/refresh' }),
      {
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        },
      },
    ])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch)

    await expect(client.request(connection.id, { path: '/projects' })).rejects.toMatchObject({
      message: 'ORYH credential refresh failed.',
      code: 'refresh-failed',
      status: 502,
    })
  })

  it("addresses ORYH's MCP endpoint from the deployment root with the same credential", async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh-token', expiresAt: null })
    const fetcher = new ScriptedFetcher([jsonResponse(200, { jsonrpc: '2.0', id: 1, result: {} })])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch)

    await client.request(connection.id, {
      path: '/mcp',
      root: true,
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(fetcher.calls.map(call => call.input)).toEqual(['https://oryh.example/mcp'])
    expect(header(fetcher.calls[0]?.init, 'X-API-Key')).toBe('access-key')
  })

  it('refreshes an access key before its advertised expiry instead of sending a known-stale request', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    const now = new Date('2026-08-29T00:00:00Z')
    await credentials.write(connection.id, {
      accessKey: 'nearly-expired-access-key',
      refreshToken: 'refresh-token',
      expiresAt: '2026-08-29T00:00:30Z',
    })
    const fetcher = new ScriptedFetcher([
      jsonResponse(200, {
        data: { api_key: 'fresh-access-key', refresh_token: 'fresh-refresh-token', expires_at: '2026-08-30T00:00:00Z' },
        meta: {},
      }),
      jsonResponse(200, { data: [], meta: { total: 0 } }),
    ])
    const client = new OryhHttpClient(connections, credentials, fetcher.fetch, {
      clock: () => now,
      refreshAheadMs: 60_000,
    })

    await expect(client.request(connection.id, { path: '/projects' })).resolves.toEqual({
      data: [],
      meta: { total: 0 },
    })
    expect(fetcher.calls.map(call => call.input)).toEqual([
      'https://oryh.example/api/v1/auth/token/refresh',
      'https://oryh.example/api/v1/projects',
    ])
    expect(header(fetcher.calls[1]?.init, 'X-API-Key')).toBe('fresh-access-key')
  })

  it('shares one refresh rotation when concurrent requests observe the same expired access key', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity() })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, {
      accessKey: 'expired-access-key',
      refreshToken: 'refresh-token',
      expiresAt: null,
    })
    let initialRequests = 0
    let releaseInitialRequests: (() => void) | undefined
    const initialRequestsReady = new Promise<void>(resolve => {
      releaseInitialRequests = resolve
    })
    let refreshCalls = 0
    const fetcher = async (input: string, init?: RequestInit) => {
      if (input.endsWith('/projects')) {
        if (header(init, 'X-API-Key') === 'expired-access-key') {
          initialRequests += 1
          if (initialRequests === 2) releaseInitialRequests?.()
          await initialRequestsReady
          return jsonResponse(401, { detail: 'API key expired — POST /auth/token/refresh' })
        }
        return jsonResponse(200, { data: [], meta: { total: 0 } })
      }
      if (input.endsWith('/auth/token/refresh')) {
        refreshCalls += 1
        return jsonResponse(200, {
          data: { api_key: 'fresh-access-key', refresh_token: 'fresh-refresh-token', expires_at: null },
          meta: {},
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    }
    const client = new OryhHttpClient(connections, credentials, fetcher)

    await expect(
      Promise.all([
        client.request(connection.id, { path: '/projects' }),
        client.request(connection.id, { path: '/projects' }),
      ]),
    ).resolves.toEqual([
      { data: [], meta: { total: 0 } },
      { data: [], meta: { total: 0 } },
    ])
    expect(refreshCalls).toBe(1)
  })
})
