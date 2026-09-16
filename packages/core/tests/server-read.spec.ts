import { expect, it, vi } from 'vitest'
import { createServerReadHost, assertServerRead, OryhClientController, connectionId } from '../src/index.js'
const identity = { user: { id: 'u-a', email: 'a@example.test', name: null, role: 'member', employeeId: 'e-a' }, tenant: { id: 't-a', slug: 'a', name: 'A', environmentId: null }, permissions: ['master_data.manage'] }
function setup() {
  const abort = new AbortController()
  const state = { user: 'u-a', tenant: 't-a', pending: undefined as Promise<void> | undefined }
  const request = vi.fn(async (request: { path: string }) => {
    if (request.path === '/auth/me') return { data: { id: state.user, tenant_id: state.tenant, email: 'a@example.test', role: 'member', employee_id: 'e-a', tenant: { slug: state.tenant }, permissions: ['master_data.manage'] } }
    await state.pending
    return { data: [], meta: { total: 0 } }
  })
  return { abort, state, request, binding: { origin: 'https://oryh.example.test', identity, signal: abort.signal, request } }
}
it('reuses the existing controller and typed business operations with no local credential access', async () => {
  const f = setup(), host = await createServerReadHost(f.binding), controller = new OryhClientController(host)
  const [connection] = await controller.listConnections()
  expect(connection?.identity.tenant.id).toBe('t-a')
  await controller.execute(connection!.id, 'list-projects')
  expect(f.request.mock.calls.map(c => c[0].path)).toEqual(['/auth/me', '/projects'])
})
it('rejects device authorization and ZIP skills even when called directly', async () => {
  const f = setup(), host = await createServerReadHost(f.binding)
  await expect(host.beginDeviceConnection('https://elsewhere.test', 'x')).rejects.toThrow()
  expect(() => host.createSkillBundle('/unused')).toThrow('MCP')
  expect(f.request).toHaveBeenCalledTimes(1)
})
it('requires the authenticated response to match the injected owner', async () => {
  const f = setup(); f.state.tenant = 't-other'
  await expect(createServerReadHost(f.binding)).rejects.toThrow('no longer belongs')
})
it('rejects writes, credential paths, absolute URLs, traversal and encoded paths', () => {
  for (const request of [ { path: '/projects', method: 'POST' }, { path: '/projects', body: {} }, { path: '/auth/refresh' }, { path: '/my/skill-bundle' }, { path: '//elsewhere.test/projects' }, { path: '/x/../projects' }, { path: '/%70rojects' } ]) {
    expect(() => assertServerRead(request as Parameters<typeof assertServerRead>[0])).toThrow()
  }
  expect(() => assertServerRead({ path: '/todos?title=%E5%B7%A5%E6%97%B6' })).not.toThrow()
})
it('revocation drops an in-flight result and disallows cached result reuse', async () => {
  const f = setup(), host = await createServerReadHost(f.binding), [connection] = await host.connections()
  const previous = await host.executeProjects(connection!.id)
  let done!: () => void; f.state.pending = new Promise<void>(resolve => { done = resolve })
  const pending = host.executeProjects(connection!.id)
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3))
  f.abort.abort(); done()
  await expect(pending).rejects.toThrow()
  await expect(host.reuseProjectResult(connection!.id, previous.id)).rejects.toThrow()
})
it('foreign connection IDs do not reach the delegated transport', async () => {
  const f = setup(), host = await createServerReadHost(f.binding)
  await expect(host.executeProjects(connectionId('foreign'))).rejects.toThrow()
  expect(f.request).toHaveBeenCalledTimes(1)
})
it('does not pass transport diagnostics into the business response', async () => {
  const f = setup(), host = await createServerReadHost(f.binding), [connection] = await host.connections()
  f.request.mockRejectedValueOnce(new Error('private-credential-diagnostic'))
  await expect(host.executeProjects(connection!.id)).rejects.toThrow('Server business request failed')
})
