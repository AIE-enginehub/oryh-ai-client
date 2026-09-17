import { describe, expect, it } from 'vitest'
import { MemoryCredentialVault, OryhClientController, OryhClientHost, OryhClientRemoteAdapter } from '../src/index.js'
import { jsonResponse, ScriptedFetcher } from './fixtures.js'

describe('OryhClientController', () => {
  it('keeps device authorization state Host-side and exposes reusable registered results', async () => {
    const fetcher = new ScriptedFetcher([
      jsonResponse(201, {
        data: {
          device_code: 'private-device-code',
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
          api_key: 'private-access-key',
          refresh_token: 'private-refresh-token',
          expires_at: null,
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
          permissions: [
            'master_data.manage',
            'expense.submit_own',
            'timesheet.submit_own',
            'approval.record',
            'order.submit_own',
            'inventory.manage',
          ],
          tenant_id: 'tenant-1',
          tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' },
          environment_id: 'test',
        },
        meta: {},
      }),
      jsonResponse(200, {
        data: [
          {
            id: 'project-1',
            project_code: 'P-01',
            project_name: 'Pilot',
            client: null,
            status: 'active',
            start_date: null,
            end_date: null,
          },
        ],
        meta: { total: 1 },
      }),
    ])
    const host = new OryhClientHost({
      credentialVault: new MemoryCredentialVault(),
      fetcher: fetcher.fetch,
      clock: () => new Date('2026-08-28T00:00:00Z'),
    })
    const controller = new OryhClientController(host)

    const started = await controller.beginConnection('https://oryh.example', 'ORYH AI Client')
    expect(JSON.stringify(started)).not.toContain('private-device-code')
    const connected = await controller.pollConnection(started.authorizationId)
    if (connected.state !== 'connected') throw new Error('Expected a connected device flow')
    expect(JSON.stringify(connected)).not.toContain('private-access-key')
    expect(controller.listOperations().map(operation => operation.id)).toEqual([
      'my-open-todos',
      'my-expense-claims',
      'list-projects',
    ])

    const result = await controller.execute(connected.connection.id, 'list-projects')
    expect(result.result.data).toEqual([expect.objectContaining({ name: 'Pilot' })])
    await expect(controller.reuse(connected.connection.id, 'list-projects', result.id)).resolves.toEqual(result)
    expect(fetcher.calls).toHaveLength(4)
  })

  it('forgets a cancelled device authorization through the browser-safe Remote adapter', async () => {
    const fetcher = new ScriptedFetcher([
      jsonResponse(201, {
        data: {
          device_code: 'private-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://oryh.example/web/device',
          verification_uri_complete: 'https://oryh.example/web/device?code=ABCD-EFGH',
          expires_in: 900,
          interval: 5,
        },
        meta: {},
      }),
    ])
    const host = new OryhClientHost({ credentialVault: new MemoryCredentialVault(), fetcher: fetcher.fetch })
    const remote = new OryhClientRemoteAdapter(new OryhClientController(host))

    const started = await remote.beginConnection('https://oryh.example', 'ORYH AI Client')
    expect(JSON.stringify(started)).not.toContain('private-device-code')
    await remote.cancelConnection(started.authorizationId)

    await expect(remote.pollConnection(started.authorizationId)).rejects.toMatchObject({
      code: 'connection-not-found',
    })
    expect(fetcher.calls).toHaveLength(1)
  })
})
