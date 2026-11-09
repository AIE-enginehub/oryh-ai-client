import { describe, expect, it } from 'vitest'
import { ConnectionRegistry, DeviceFlowConnector, MemoryCredentialVault } from '../src/index.js'
import { jsonResponse, ScriptedFetcher } from './fixtures.js'

describe('DeviceFlowConnector', () => {
  it('keeps the issued credential Host-side and publishes only a connected summary', async () => {
    const connections = new ConnectionRegistry()
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
      jsonResponse(200, { data: { status: 'pending', interval: 5 }, meta: {} }),
      jsonResponse(200, {
        data: {
          status: 'approved',
          api_key: 'issued-access-key',
          refresh_token: 'issued-refresh-token',
          expires_at: '2099-08-29T00:00:00Z',
        },
        meta: {},
      }),
      jsonResponse(200, {
        data: {
          id: 'user-1',
          email: 'member@example.com',
          name: 'Member',
          role: 'member',
          employee_id: 'employee-1',
          tenant_id: 'tenant-1',
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' },
          environment_id: 'production',
        },
        meta: {},
      }),
    ])
    const connector = new DeviceFlowConnector(connections, credentials, fetcher.fetch)

    const attempt = await connector.begin('https://oryh.example', 'ORYH AI Client')
    expect(attempt.prompt).toEqual({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://oryh.example/web/device',
      verificationUriComplete: 'https://oryh.example/web/device?code=ABCD-EFGH',
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    })
    await expect(attempt.pollOnce()).resolves.toEqual({ state: 'pending', pollIntervalSeconds: 5 })

    const outcome = await attempt.pollOnce()
    expect(outcome.state).toBe('connected')
    if (outcome.state !== 'connected') throw new Error('Expected a connected device flow')
    expect(outcome.connection).toMatchObject({
      origin: 'https://oryh.example',
      identity: { tenant: { slug: 'acme' }, user: { employeeId: 'employee-1' } },
    })
    expect(JSON.stringify(outcome.connection)).not.toContain('issued-access-key')
    await expect(credentials.read(outcome.connection.id)).resolves.toEqual({
      accessKey: 'issued-access-key',
      refreshToken: 'issued-refresh-token',
      expiresAt: '2099-08-29T00:00:00Z',
    })
  })

  it('takes no connection from an approval the deployment refuses, and keeps no credential of it', async () => {
    const connections = new ConnectionRegistry()
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
        data: { status: 'approved', api_key: 'other-key', refresh_token: 'other-refresh', expires_at: null },
        meta: {},
      }),
      jsonResponse(200, {
        data: {
          id: 'user-2',
          email: 'other@example.com',
          name: 'Other',
          role: 'member',
          employee_id: null,
          tenant_id: 'tenant-1',
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' },
          environment_id: 'production',
        },
        meta: {},
      }),
    ])
    const seen: string[] = []
    const written: Parameters<typeof credentials.write>[0][] = []
    const write = credentials.write.bind(credentials)
    credentials.write = async (id, credential) => {
      written.push(id)
      await write(id, credential)
    }
    // The deployment belongs to user-1. Someone else was signed in to ORYH when the approval was given.
    const connector = new DeviceFlowConnector(
      connections,
      credentials,
      fetcher.fetch,
      async () => {},
      (origin, identity) => {
        seen.push(`${origin} ${identity.user.id}`)
        if (identity.user.id !== 'user-1') throw new Error('not the owner')
      },
    )
    const attempt = await connector.begin('https://oryh.example', 'ORYH AI Client')
    await expect(attempt.pollOnce()).rejects.toThrow('not the owner')
    expect(seen).toEqual(['https://oryh.example user-2'])
    expect(connections.list()).toEqual([])
    // The credential was written to ask ORYH who it is, and is gone again with the connection.
    expect(written).toHaveLength(1)
    await expect(credentials.read(written[0]!)).resolves.toBeUndefined()
  })
})
