import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileCredentialHandoff, MemoryConnectionStore, MemoryCredentialVault, OryhClientHost, type HandedOffCredential } from '../src/index.js'
import { header, jsonResponse, ScriptedFetcher } from './fixtures.js'

const me = (userId = 'user-1') => jsonResponse(200, {
  data: { id: userId, email: `${userId}@example.com`, name: null, role: 'member', employee_id: null, tenant_id: 'tenant-1', tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' }, environment_id: null },
  meta: {},
})
const handed = (accessKey: string): HandedOffCredential => ({ origin: 'https://oryh.example', credential: { accessKey, refreshToken: `${accessKey}-refresh`, expiresAt: null } })
function queue(items: HandedOffCredential[]) { return { take: async () => items.shift() } }

describe('credential handoff', () => {
  const directories: string[] = []
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

  it('adopts a signed-in credential as a verified connection, and replaces it when the same person signs in again', async () => {
    const credentials = new MemoryCredentialVault()
    const store = new MemoryConnectionStore()
    const fetcher = new ScriptedFetcher([me(), me()])
    const items = [handed('first')]
    const host = new OryhClientHost({ credentialVault: credentials, connectionStore: store, fetcher: fetcher.fetch, credentialHandoff: queue(items) })

    const [connection] = await host.connections()
    expect(connection?.identity.user.id).toBe('user-1')
    expect(header(fetcher.calls[0]?.init, 'X-API-Key')).toBe('first')
    await expect(credentials.read(connection!.id)).resolves.toMatchObject({ accessKey: 'first' })
    await expect(store.load()).resolves.toHaveLength(1)

    items.push(handed('second'))
    const again = await host.connections()
    expect(again.map(c => c.id)).toEqual([connection!.id])
    await expect(credentials.read(connection!.id)).resolves.toMatchObject({ accessKey: 'second' })
  })

  it('leaves no connection behind when the credential does not verify', async () => {
    const credentials = new MemoryCredentialVault()
    const fetcher = new ScriptedFetcher([jsonResponse(401, { detail: 'invalid api key' })])
    const host = new OryhClientHost({ credentialVault: credentials, fetcher: fetcher.fetch, credentialHandoff: queue([handed('bad')]) })
    await expect(host.connections()).rejects.toThrow()
    await expect(host.connections()).resolves.toEqual([])
  })

  it('reads a handoff file once and removes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oryh-handoff-'))
    directories.push(directory)
    const path = join(directory, 'handoff.json')
    const handoff = fileCredentialHandoff(path)
    await expect(handoff.take()).resolves.toBeUndefined()
    await writeFile(path, JSON.stringify({ origin: 'https://oryh.example/', accessKey: 'k', refreshToken: 'r', expiresAt: null }))
    await expect(handoff.take()).resolves.toEqual({ origin: 'https://oryh.example', credential: { accessKey: 'k', refreshToken: 'r', expiresAt: null } })
    await expect(stat(path)).rejects.toThrow()
    await writeFile(path, '{"origin":"https://oryh.example"}')
    await expect(handoff.take()).rejects.toThrow(/malformed/)
    await expect(stat(path)).rejects.toThrow()
  })
})
