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
      // The to-do list is two reads: the open ones, then the most recent of the rest.
      jsonResponse(200, {
        data: [
          {
            id: 'todo-1',
            employee_id: 'employee-1',
            entity_type: 'sales_order',
            entity_id: 'order-1',
            title: 'Pilot',
            status: 'open',
          },
        ],
        meta: { total: 1 },
      }),
      jsonResponse(200, { data: [], meta: { total: 1 } }),
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
    expect(controller.listOperations().map(operation => operation.id)).toEqual(['my-open-todos'])

    const result = await controller.execute(connected.connection.id, 'my-open-todos')
    expect(result.result.data).toEqual([expect.objectContaining({ title: 'Pilot' })])
    await expect(controller.reuse(connected.connection.id, 'my-open-todos', result.id)).resolves.toEqual(result)
    expect(fetcher.calls).toHaveLength(5)
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
