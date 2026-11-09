import { expect, it } from 'vitest'
import {
  ConnectionRegistry,
  type DelegatedResponse,
  MemoryCredentialVault,
  OryhHttpClient,
  type OryhRequest,
  PageReader,
} from '../src/index.js'

const identity = {
  permissions: ['sales_orders.read'],
  user: { id: 'user-1', email: 'a@example.com', name: null, role: 'member', employeeId: 'employee-1' },
  tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme', environmentId: null },
}

it('reads with GET only, as the page owner, and refuses what a page has no business reading', async () => {
  const connections = new ConnectionRegistry()
  const connection = connections.add({ origin: 'https://oryh.example', identity })
  connections.markVerified(connection.id, identity)
  const sent: OryhRequest[] = []
  const http = new OryhHttpClient(
    connections,
    new MemoryCredentialVault(),
    async () => {
      throw new Error('not over the network')
    },
    {
      delegated: {
        signal: new AbortController().signal,
        send: async (request): Promise<DelegatedResponse> => {
          sent.push(request)
          return { status: 200, body: { data: [{ id: 'o1' }] } }
        },
      },
    },
  )
  const verified: string[] = []
  const reader = new PageReader(http, async id => {
    verified.push(id)
  })
  expect(await reader.read(connection.id, '/sales-orders', { status: 'confirmed', page: 2, size: 100 })).toEqual({
    data: [{ id: 'o1' }],
  })
  expect(sent[0]).toMatchObject({ method: 'GET', path: '/sales-orders?status=confirmed&page=2&size=100' })
  expect(sent[0]).not.toHaveProperty('body')
  expect(verified).toEqual([connection.id])
  await reader.read(connection.id, '/sales-orders/o1/detail')
  expect(sent[1]).toMatchObject({ method: 'GET', path: '/sales-orders/o1/detail' })
  // A query string in the path, a way out of /api/v1, keys and sign-in are refused before anything is sent.
  for (const path of ['/sales-orders?status=x', '/../mcp', '/sales-orders//x', '/api-keys', '/oauth/token', 'orders'])
    await expect(reader.read(connection.id, path)).rejects.toThrow()
  await expect(reader.read(connection.id, '/sales-orders', { 'a&b': 1 })).rejects.toThrow('查询参数名')
  expect(sent).toHaveLength(2)
})
