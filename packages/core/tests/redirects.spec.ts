import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { ConnectionRegistry, DeviceFlowConnector, MemoryCredentialVault, OryhHttpClient } from '../src/index.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        }),
    ),
  )
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing TCP address')
  return `http://127.0.0.1:${address.port}`
}

it.each([302, 307, 308])('does not send credentials to a redirect target (%s)', async status => {
  let targetRequests = 0
  const target = await listen(
    createServer((_request, response) => {
      targetRequests += 1
      response.end('{}')
    }),
  )
  const origin = await listen(
    createServer((request, response) => {
      if (request.url === '/api/v1/auth/device/start') {
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            data: {
              device_code: 'synthetic-device-code',
              user_code: 'ABCD-EFGH',
              verification_uri: `${origin}/web/device`,
              verification_uri_complete: `${origin}/web/device?code=ABCD-EFGH`,
              expires_in: 900,
              interval: 5,
            },
          }),
        )
        return
      }
      response.writeHead(status, { Location: target })
      response.end()
    }),
  )
  const connections = new ConnectionRegistry()
  const credentials = new MemoryCredentialVault()
  const connection = connections.add({
    origin,
    identity: {
      user: { id: 'user', email: 'test@example.invalid', name: null, role: 'member', employeeId: null },
      tenant: { id: 'tenant', slug: 'tenant', name: null, environmentId: null },
    },
  })
  await credentials.write(connection.id, {
    accessKey: 'synthetic-key',
    refreshToken: 'synthetic-refresh',
    expiresAt: null,
  })
  const http = new OryhHttpClient(connections, credentials, fetch)
  await expect(http.request(connection.id, { path: '/projects' })).rejects.toThrow()
  await credentials.write(connection.id, {
    accessKey: 'synthetic-key',
    refreshToken: 'synthetic-refresh',
    expiresAt: '2020-01-01T00:00:00Z',
  })
  await expect(http.request(connection.id, { path: '/projects' })).rejects.toThrow()
  const attempt = await new DeviceFlowConnector(connections, credentials, fetch).begin(origin, 'test')
  await expect(attempt.pollOnce()).rejects.toThrow()
  expect(targetRequests).toBe(0)
})
