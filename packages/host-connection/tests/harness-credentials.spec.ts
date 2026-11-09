import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials/types'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import {
  type ConnectionSummary,
  type CredentialPair,
  connectionId,
  type Fetcher,
  MemoryConnectionStore,
  OryhClientHost,
} from '@oryh/ai-client-core'
import { expect, it, vi } from 'vitest'
import { HarnessCredentialVault } from '../src/harness-credentials.js'

const pair: CredentialPair = {
  accessKey: 'private-enterprise-access',
  refreshToken: 'private-enterprise-refresh',
  expiresAt: null,
}
const connection: ConnectionSummary = {
  id: connectionId('oryh-1'),
  origin: 'https://oryh.example',
  connectedAt: '2026-10-23T00:00:00Z',
  identity: {
    user: { id: 'user-a', email: 'a@example.test', name: 'A', role: 'member', employeeId: null },
    tenant: { id: 'tenant-a', slug: 'a', name: 'A', environmentId: null },
  },
}
class Records {
  readonly values = new Map<CredentialKey, CredentialRecord>()
  failCommit = false
  tail: Promise<unknown> = Promise.resolve()
  async readRecord(key: CredentialKey) {
    return this.values.get(key)
  }
  async modifyRecord(
    key: CredentialKey,
    mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ) {
    const result = this.tail.then(async () => {
      const next = await mutate(this.values.get(key))
      if (next !== undefined) {
        if (this.failCommit) throw new Error('private storage diagnostic')
        this.values.set(key, structuredClone(next))
      }
      return this.values.get(key)
    })
    this.tail = result.catch(() => {})
    return result
  }
}
function fixture(
  initial: readonly ConnectionSummary[] = [connection],
  records = new Records(),
  directory = '/app/business',
) {
  const store = new MemoryConnectionStore(initial)
  const legacy = { read: vi.fn(async () => pair), write: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  const legacyVault = vi.fn(() => legacy)
  const make = () =>
    new HarnessCredentialVault({ credentials: records, dataDirectory: directory, connectionStore: store, legacyVault })
  return { store, records, legacy, legacyVault, make, vault: make() }
}

function aggregateKey(directory = '/app/business') {
  return credentialKey('oryh-connection', `vault-${createHash('sha256').update(resolve(directory)).digest('hex')}`)
}

it('converts the local validation format once without Keychain, preserving restart and sign-out semantics', async () => {
  const f = fixture()
  const aggregate = { kind: 'grant', payload: { version: 1, connections: { [connection.id]: pair } } } as const
  f.records.values.set(aggregateKey(), aggregate)
  f.legacy.read.mockRejectedValue(new Error('Keychain must not be accessed'))
  await f.vault.bindConnection(connection)
  expect(await Promise.all(Array.from({ length: 30 }, () => f.vault.read(connection.id)))).toEqual(Array(30).fill(pair))
  expect(f.legacyVault).not.toHaveBeenCalled()
  expect(f.records.values.size).toBe(2)
  expect(f.records.values.get(aggregateKey())).toEqual(aggregate)
  const next = f.make()
  await next.bindConnection(connection)
  expect(await next.readFresh(connection.id)).toEqual(pair)
  await next.remove(connection.id)
  const restarted = f.make()
  await restarted.bindConnection(connection)
  expect(await restarted.read(connection.id)).toBeUndefined()
  expect(f.legacyVault).not.toHaveBeenCalled()
})

it('does not revive Keychain credentials missing from an initialized local-format record', async () => {
  const f = fixture()
  f.records.values.set(aggregateKey(), { kind: 'grant', payload: { version: 1, connections: {} } })
  await f.vault.bindConnection(connection)
  expect(await f.vault.read(connection.id)).toBeUndefined()
  expect(f.legacyVault).not.toHaveBeenCalled()
  const tombstone = [...f.records.values.values()].find(record => record !== f.records.values.get(aggregateKey()))
  expect(tombstone).toMatchObject({ kind: 'grant', payload: { credential: null } })
})

it.each([
  { kind: 'api-key', key: 'invalid-local-format' },
  { kind: 'grant', payload: { version: 2, connections: {} } },
  { kind: 'grant', payload: { version: 1, connections: [] } },
  { kind: 'grant', payload: { version: 1, connections: { 'oryh-1': { ...pair, accessKey: '' } } } },
] satisfies CredentialRecord[])('refuses corrupt local records without falling back to Keychain: %#', async record => {
  const f = fixture()
  f.records.values.set(aggregateKey(), record)
  await f.vault.bindConnection(connection)
  await expect(f.vault.read(connection.id)).rejects.toMatchObject({ code: 'credential-store-failed' })
  expect(f.legacyVault).not.toHaveBeenCalled()
})

it('prefers remote-format credentials and their sign-out marker over an old local-format record', async () => {
  const f = fixture()
  await f.vault.bindConnection(connection)
  await f.vault.write(connection.id, { ...pair, accessKey: 'remote-format-current' })
  f.records.values.set(aggregateKey(), {
    kind: 'grant',
    payload: { version: 1, connections: { [connection.id]: pair } },
  })
  expect((await f.vault.readFresh(connection.id))?.accessKey).toBe('remote-format-current')
  await f.vault.remove(connection.id)
  expect(await f.vault.read(connection.id)).toBeUndefined()
  expect(f.legacyVault).not.toHaveBeenCalled()
})

it('never serves a cached migration secret after its committed record was externally removed', async () => {
  const f = fixture()
  await f.vault.bindConnection(connection)
  expect(await f.vault.read(connection.id)).toEqual(pair)
  const key = [...f.records.values.keys()][0]!
  f.records.values.delete(key)
  expect(await f.vault.read(connection.id)).toBeUndefined()
  expect(await f.vault.readFresh(connection.id)).toBeUndefined()
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
  await f.vault.write(connection.id, { ...pair, accessKey: 'explicitly-replaced' })
  f.records.values.delete(key)
  expect(await f.vault.read(connection.id)).toBeUndefined()
  await f.vault.remove(connection.id)
  f.records.values.delete(key)
  expect(await f.vault.read(connection.id)).toBeUndefined()
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
})

it('repairs the newest historical duplicate when the same account signs in again', async () => {
  const latest = { ...connection, id: connectionId('oryh-2'), connectedAt: '2026-10-24T00:00:00Z' }
  const f = fixture([connection, latest])
  const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) })
  const answers = [
    response({
      device_code: 'device',
      user_code: 'CODE',
      verification_uri: connection.origin + '/device',
      verification_uri_complete: connection.origin + '/device?code=CODE',
      expires_in: 600,
      interval: 1,
    }),
    response({ status: 'approved', api_key: 'repaired-newest', refresh_token: 'repaired-refresh', expires_at: null }),
    response({
      ...connection.identity.user,
      tenant_id: 'tenant-a',
      tenant: connection.identity.tenant,
      environment_id: null,
    }),
  ]
  const host = new OryhClientHost({
    credentialVault: f.vault,
    connectionStore: f.store,
    fetcher: async () => answers.shift()!,
  })
  await host.connections()
  const attempt = await host.beginDeviceConnection(connection.origin, 'ORYH')
  expect(await attempt.pollOnce()).toMatchObject({ state: 'connected', connection: { id: latest.id } })
  expect((await host.connections()).map(value => value.id)).toEqual([connection.id, latest.id])
  const restarted = f.make()
  await restarted.bindConnection(latest)
  expect((await restarted.read(latest.id))?.accessKey).toBe('repaired-newest')
})

it('migrates once, commits through Harness and restores next launch without touching the OS vault', async () => {
  const f = fixture()
  await f.vault.bindConnection(connection)
  const values = await Promise.all(Array.from({ length: 20 }, () => f.vault.read(connection.id)))
  expect(values.every(v => v?.accessKey === pair.accessKey)).toBe(true)
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
  expect(f.legacy.write).not.toHaveBeenCalled()
  expect(f.legacy.remove).not.toHaveBeenCalled()
  const payload = [...f.records.values.values()][0]!
  expect(payload).toMatchObject({
    kind: 'grant',
    payload: { binding: { origin: connection.origin, userId: 'user-a', tenantId: 'tenant-a' } },
  })
  const next = f.make()
  await next.bindConnection(connection)
  await expect(next.read(connection.id)).resolves.toEqual(pair)
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
})

it('never opens the OS vault for a new sign-in, and binds identity before exposing the connection', async () => {
  const f = fixture([])
  const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) })
  const answers = [
    response({
      device_code: 'device',
      user_code: 'CODE',
      verification_uri: 'https://oryh.example/device',
      verification_uri_complete: 'https://oryh.example/device?code=CODE',
      expires_in: 600,
      interval: 1,
    }),
    response({ status: 'approved', api_key: pair.accessKey, refresh_token: pair.refreshToken, expires_at: null }),
    response({
      ...connection.identity.user,
      employee_id: null,
      tenant_id: 'tenant-a',
      tenant: connection.identity.tenant,
      environment_id: null,
    }),
  ]
  const host = new OryhClientHost({
    credentialVault: f.vault,
    connectionStore: f.store,
    fetcher: async () => answers.shift()!,
  })
  const attempt = await host.beginDeviceConnection(connection.origin, 'ORYH')
  const outcome = await attempt.pollOnce()
  expect(outcome.state).toBe('connected')
  expect(f.legacyVault).not.toHaveBeenCalled()
  expect([...f.records.values.values()][0]).toMatchObject({
    kind: 'grant',
    payload: { binding: { userId: 'user-a', tenantId: 'tenant-a' } },
  })
  expect(JSON.stringify(await host.connections())).not.toContain(pair.accessKey)
})

it('preserves login metadata after migration denial and allows starting a new sign-in', async () => {
  const f = fixture()
  f.legacy.read.mockRejectedValue(new Error('user denied OS access'))
  const fetcher = vi.fn<Fetcher>(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        device_code: 'device',
        user_code: 'CODE',
        verification_uri: 'https://oryh.example/device',
        verification_uri_complete: 'https://oryh.example/device?code=CODE',
        expires_in: 600,
        interval: 1,
      },
    }),
  }))
  const host = new OryhClientHost({ credentialVault: f.vault, connectionStore: f.store, fetcher })
  expect(await host.connections()).toEqual([connection])
  expect(await f.store.load()).toEqual([connection])
  for (let i = 0; i < 5; i++)
    await expect(f.vault.read(connection.id)).rejects.toMatchObject({ code: 'credential-store-failed' })
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
  expect(f.records.values.size).toBe(0)
  const attempt = await host.beginDeviceConnection(connection.origin, 'ORYH')
  expect(fetcher).toHaveBeenCalledTimes(1)
  fetcher
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          status: 'approved',
          api_key: 'replacement-access',
          refresh_token: 'replacement-refresh',
          expires_at: null,
        },
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          ...connection.identity.user,
          tenant_id: 'tenant-a',
          tenant: connection.identity.tenant,
          environment_id: null,
        },
      }),
    })
  const result = await attempt.pollOnce()
  expect(result).toMatchObject({ state: 'connected', connection: { id: connection.id } })
  expect((await f.store.load()).map(value => value.id)).toEqual([connection.id])
  const next = f.make()
  await next.bindConnection(connection)
  await expect(next.read(connection.id)).resolves.toMatchObject({ accessKey: 'replacement-access' })
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
})

it('leaves old credentials intact when committing migration fails and never returns an uncommitted pair', async () => {
  const f = fixture()
  await f.vault.bindConnection(connection)
  f.records.failCommit = true
  await expect(f.vault.read(connection.id)).rejects.toMatchObject({ code: 'credential-store-failed' })
  expect(f.records.values.size).toBe(0)
  expect(f.legacy.remove).not.toHaveBeenCalled()
  f.records.failCommit = false
  const next = f.make()
  await next.bindConnection(connection)
  await expect(next.read(connection.id)).resolves.toEqual(pair)
})

it.each(['origin', 'user', 'tenant'] as const)(
  'rejects %s substitution instead of borrowing a stored grant',
  async field => {
    const f = fixture([])
    await f.vault.write(connection.id, pair)
    await f.vault.bindConnection(connection)
    const changed = structuredClone(connection)
    if (field === 'origin') Object.assign(changed, { origin: 'https://other.example' })
    if (field === 'user') Object.assign(changed.identity.user, { id: 'other-user' })
    if (field === 'tenant') Object.assign(changed.identity.tenant, { id: 'other-tenant' })
    await expect(f.make().bindConnection(changed)).rejects.toMatchObject({ code: 'credential-store-failed' })
    expect(f.legacyVault).not.toHaveBeenCalled()
  },
)

it('isolates identical connection ids in separate product data roots and preserves unrelated Harness records', async () => {
  const records = new Records()
  const unrelated = credentialKey('deepseek-account', 'session')
  records.values.set(unrelated, { kind: 'grant', payload: { fixture: 'unchanged' } })
  const a = fixture([], records, '/app/a'),
    b = fixture([], records, '/app/b')
  await a.vault.write(connection.id, pair)
  await b.vault.write(connection.id, { ...pair, accessKey: 'b-only' })
  await expect(a.vault.read(connection.id)).resolves.toMatchObject({ accessKey: pair.accessKey })
  await expect(b.vault.read(connection.id)).resolves.toMatchObject({ accessKey: 'b-only' })
  expect(records.values.size).toBe(3)
  expect(records.values.get(unrelated)).toEqual({ kind: 'grant', payload: { fixture: 'unchanged' } })
})

it('retains a credential-free tombstone on sign-out so a legacy entry cannot resurrect the account', async () => {
  const f = fixture()
  await f.vault.bindConnection(connection)
  await f.vault.read(connection.id)
  await f.vault.remove(connection.id)
  const next = f.make()
  await next.bindConnection(connection)
  await expect(next.read(connection.id)).resolves.toBeUndefined()
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
  expect(f.legacy.remove).not.toHaveBeenCalled()
  expect(JSON.stringify([...f.records.values.values()])).not.toContain(pair.accessKey)
})

it('persists through the real public Harness provider, with restricted permissions, and reloads after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oryh-harness-vault-'))
  const path = join(dir, '.credentials.yaml')
  const start = async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
    await fiber.await()
    return { ctx, fiber }
  }
  let active = await start()
  try {
    const legacyVault = vi.fn(() => {
      throw new Error('Fresh login must not open keychain')
    })
    const make = () =>
      new HarnessCredentialVault({
        credentials: active.ctx.credentials,
        dataDirectory: join(dir, 'business'),
        connectionStore: new MemoryConnectionStore([]),
        legacyVault,
      })
    const first = make()
    await first.write(connection.id, pair)
    await first.bindConnection(connection)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0)
    expect(await readFile(path, 'utf8')).toContain('oryh-connection/')
    await active.fiber.dispose()
    active = await start()
    const second = make()
    await second.bindConnection(connection)
    await expect(second.readFresh(connection.id)).resolves.toEqual(pair)
    expect(legacyVault).not.toHaveBeenCalled()
  } finally {
    await active.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it('refuses a migrated credential whose actual ORYH tenant differs from its saved identity', async () => {
  const f = fixture()
  const host = new OryhClientHost({
    credentialVault: f.vault,
    connectionStore: f.store,
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          ...connection.identity.user,
          tenant_id: 'wrong-tenant',
          tenant: { id: 'wrong-tenant', slug: 'wrong' },
          environment_id: null,
        },
      }),
    }),
  })
  await host.connections()
  await expect(host.verifyConnection(connection.id)).rejects.toMatchObject({ code: 'connection-identity-mismatch' })
  expect(await f.store.load()).toEqual([connection])
  expect(f.legacy.read).toHaveBeenCalledTimes(1)
})

it('reloads a completed migration from the real Harness file with the old vault unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oryh-migration-persist-'))
  const path = join(dir, '.credentials.yaml')
  const start = async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
    await fiber.await()
    return { ctx, fiber }
  }
  let active = await start()
  const legacy = { read: vi.fn(async () => pair), write: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  try {
    const make = () =>
      new HarnessCredentialVault({
        credentials: active.ctx.credentials,
        dataDirectory: join(dir, 'business'),
        connectionStore: new MemoryConnectionStore([connection]),
        legacyVault: () => legacy,
      })
    const first = make()
    await first.bindConnection(connection)
    await expect(first.read(connection.id)).resolves.toEqual(pair)
    await active.fiber.dispose()
    active = await start()
    legacy.read.mockRejectedValue(new Error('OS vault unavailable after migration'))
    const second = make()
    await second.bindConnection(connection)
    await expect(second.readFresh(connection.id)).resolves.toEqual(pair)
    expect(legacy.read).toHaveBeenCalledTimes(1)
    expect(legacy.remove).not.toHaveBeenCalled()
  } finally {
    await active.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it.each(['origin', 'user', 'tenant'] as const)(
  'keeps a new %s distinct instead of replacing another identity on sign-in',
  async field => {
    const f = fixture()
    const target = structuredClone(connection)
    if (field === 'origin') Object.assign(target, { origin: 'https://another.example' })
    if (field === 'user') Object.assign(target.identity.user, { id: 'user-b' })
    if (field === 'tenant') Object.assign(target.identity.tenant, { id: 'tenant-b' })
    const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) })
    const answers = [
      response({
        device_code: 'new-device',
        user_code: 'CODE',
        verification_uri: target.origin + '/device',
        verification_uri_complete: target.origin + '/device?code=CODE',
        expires_in: 600,
        interval: 1,
      }),
      response({
        status: 'approved',
        api_key: 'new-identity-access',
        refresh_token: 'new-identity-refresh',
        expires_at: null,
      }),
      response({
        ...target.identity.user,
        tenant_id: target.identity.tenant.id,
        tenant: target.identity.tenant,
        environment_id: null,
      }),
    ]
    const host = new OryhClientHost({
      credentialVault: f.vault,
      connectionStore: f.store,
      fetcher: async () => answers.shift()!,
    })
    await host.connections()
    const attempt = await host.beginDeviceConnection(target.origin, 'ORYH')
    const outcome = await attempt.pollOnce()
    expect(outcome).toMatchObject({
      state: 'connected',
      connection: { id: 'oryh-2', origin: target.origin, identity: target.identity },
    })
    expect(await f.vault.read(connection.id)).toEqual(pair)
    expect(await host.connections()).toHaveLength(2)
  },
)
