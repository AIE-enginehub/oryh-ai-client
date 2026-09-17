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
})
