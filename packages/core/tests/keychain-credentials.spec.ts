import { describe, expect, it } from 'vitest'
import { connectionId, KeychainCredentialVault, type KeychainEntry, OryhClientError } from '../src/index.js'

class FakeKeychain {
  readonly values = new Map<string, string>()
  fail = false
  reads = 0

  entry = (service: string, account: string): KeychainEntry => {
    const key = `${service}:${account}`
    return {
      getPassword: () => {
        this.reads += 1
        if (this.fail) throw new Error('native keychain unavailable')
        return this.values.get(key) ?? null
      },
      setPassword: value => {
        if (this.fail) throw new Error('native keychain unavailable')
        this.values.set(key, value)
      },
      deleteCredential: () => {
        if (this.fail) throw new Error('native keychain unavailable')
        return this.values.delete(key)
      },
    }
  }
}

describe('KeychainCredentialVault', () => {
  it('uses one authorized OS read for a burst of startup requests and subsequent page actions', async () => {
    const keychain = new FakeKeychain()
    const id = connectionId('oryh-1')
    keychain.values.set(
      'ORYH test:connection:oryh-1',
      JSON.stringify({ accessKey: 'a', refreshToken: 'r', expiresAt: null }),
    )
    const vault = new KeychainCredentialVault({ serviceName: 'ORYH test', entryFactory: keychain.entry })
    const credentials = await Promise.all(Array.from({ length: 20 }, () => vault.read(id)))
    expect(credentials.every(value => value?.accessKey === 'a')).toBe(true)
    await vault.read(id)
    expect(keychain.reads).toBe(1)
  })

  it('does not repeat OS authorization after denial, and an explicit successful write recovers', async () => {
    const keychain = new FakeKeychain()
    const id = connectionId('oryh-1')
    const vault = new KeychainCredentialVault({ entryFactory: keychain.entry })
    keychain.fail = true
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => vault.read(id)))
    expect(results.every(value => value.status === 'rejected')).toBe(true)
    await expect(vault.readFresh(id)).rejects.toMatchObject({ code: 'credential-store-failed' })
    expect(keychain.reads).toBe(1)
    keychain.fail = false
    await vault.write(id, { accessKey: 'new', refreshToken: 'r', expiresAt: null })
    await expect(vault.read(id)).resolves.toMatchObject({ accessKey: 'new' })
    expect(keychain.reads).toBe(1)
  })

  it('reconciles external rotations on renewal, keeps connections separate, and discards removed credentials', async () => {
    const keychain = new FakeKeychain()
    const id = connectionId('oryh-1'),
      other = connectionId('oryh-2')
    const vault = new KeychainCredentialVault({ serviceName: 'ORYH test', entryFactory: keychain.entry })
    await vault.write(id, { accessKey: 'old', refreshToken: 'r', expiresAt: null })
    await vault.write(other, { accessKey: 'other', refreshToken: 'other-r', expiresAt: null })
    keychain.values.set(
      'ORYH test:connection:oryh-1',
      JSON.stringify({ accessKey: 'rotated', refreshToken: 'r2', expiresAt: null }),
    )
    await expect(vault.read(id)).resolves.toMatchObject({ accessKey: 'old' })
    await expect(vault.readFresh(id)).resolves.toMatchObject({ accessKey: 'rotated' })
    await expect(vault.read(other)).resolves.toMatchObject({ accessKey: 'other' })
    await vault.remove(id)
    await expect(vault.read(id)).resolves.toBeUndefined()
    expect(keychain.reads).toBe(1)
  })

  it('never serves a stale cached credential after a failed write or removal', async () => {
    for (const operation of ['write', 'remove'] as const) {
      const keychain = new FakeKeychain()
      const vault = new KeychainCredentialVault({ entryFactory: keychain.entry })
      const id = connectionId('oryh-1')
      await vault.write(id, { accessKey: 'a', refreshToken: 'r', expiresAt: null })
      keychain.fail = true
      await expect(
        operation === 'write'
          ? vault.write(id, { accessKey: 'new', refreshToken: 'r2', expiresAt: null })
          : vault.remove(id),
      ).rejects.toMatchObject({ code: 'credential-store-failed' })
      await expect(vault.read(id)).rejects.toMatchObject({ code: 'credential-store-failed' })
      expect(keychain.reads).toBe(0)
    }
  })

  it('stores a credential pair only in the supplied native-keychain entry', async () => {
    const keychain = new FakeKeychain()
    const vault = new KeychainCredentialVault({ serviceName: 'ORYH test', entryFactory: keychain.entry })
    const id = connectionId('oryh-1')

    await vault.write(id, { accessKey: 'private-access-key', refreshToken: 'private-refresh-token', expiresAt: null })

    expect(keychain.values.get('ORYH test:connection:oryh-1')).toBe(
      '{"accessKey":"private-access-key","refreshToken":"private-refresh-token","expiresAt":null}',
    )
    await expect(vault.read(id)).resolves.toEqual({
      accessKey: 'private-access-key',
      refreshToken: 'private-refresh-token',
      expiresAt: null,
    })
    await vault.remove(id)
    await expect(vault.read(id)).resolves.toBeUndefined()
  })

  it('fails closed when a native credential read is corrupted or unavailable', async () => {
    const keychain = new FakeKeychain()
    const vault = new KeychainCredentialVault({ serviceName: 'ORYH test', entryFactory: keychain.entry })
    const id = connectionId('oryh-1')
    keychain.values.set('ORYH test:connection:oryh-1', '{not json')

    await expect(vault.read(id)).rejects.toMatchObject<OryhClientError>({ code: 'credential-store-failed' })
    keychain.fail = true
    await expect(
      vault.write(id, { accessKey: 'a', refreshToken: 'r', expiresAt: null }),
    ).rejects.toMatchObject<OryhClientError>({ code: 'credential-store-failed' })
  })
})
