import { describe, expect, it } from 'vitest'
import {
  connectionId,
  MemoryCredentialVault,
  MemorySavedOperationStore,
  OryhClientController,
  OryhClientError,
  OryhClientHost,
  operationResultId,
  SavedOperationRegistry,
} from '../src/index.js'
import { jsonResponse, ScriptedFetcher } from './fixtures.js'

describe('saved deterministic operations', () => {
  it('pins a verified result and refreshes its fixed operation without a model', async () => {
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
      // Each run of the to-do list is two reads: the open ones, then the most recent of the rest.
      jsonResponse(200, { data: [], meta: { total: 0 } }),
      jsonResponse(200, { data: [], meta: { total: 0 } }),
      jsonResponse(200, { data: [], meta: { total: 0 } }),
      jsonResponse(200, { data: [], meta: { total: 0 } }),
    ])
    const host = new OryhClientHost({ credentialVault: new MemoryCredentialVault(), fetcher: fetcher.fetch })
    const savedOperationStore = new MemorySavedOperationStore()
    const controller = new OryhClientController(host, { savedOperationStore })
    const started = await controller.beginConnection('https://oryh.example', 'ORYH AI Client')
    const connected = await controller.pollConnection(started.authorizationId)
    if (connected.state !== 'connected') throw new Error('Expected a connected device flow')

    const result = await controller.execute(connected.connection.id, 'my-open-todos')
    const saved = await controller.saveResult(
      connected.connection.id,
      'my-open-todos',
      result.id,
      '我的待办',
      '2026-08-28T00:00:00Z',
    )

    const restored = new OryhClientController(host, { savedOperationStore })
    await expect(restored.listSavedOperations(connected.connection.id)).resolves.toEqual([saved])
    await expect(restored.refreshSavedOperation(connected.connection.id, saved.id)).resolves.toMatchObject({
      operationId: 'my-open-todos',
    })
    expect(fetcher.calls).toHaveLength(7)
  })

  it('validates labels and refuses saved views from another connection', () => {
    const registry = new SavedOperationRegistry()
    expect(() =>
      registry.save(
        {
          connectionId: connectionId('connection-1'),
          operationId: 'my-open-todos',
          resultId: operationResultId('result-1'),
          label: ' ',
        },
        '2026-08-28T00:00:00Z',
      ),
    ).toThrow(OryhClientError)
    const saved = registry.save(
      {
        connectionId: connectionId('connection-1'),
        operationId: 'my-open-todos',
        resultId: operationResultId('result-1'),
        label: '待办',
      },
      '2026-08-28T00:00:00Z',
    )
    let error: unknown
    try {
      registry.require(connectionId('connection-2'), saved.id)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OryhClientError)
    expect((error as OryhClientError).code).toBe('cross-connection-result')
  })
})
