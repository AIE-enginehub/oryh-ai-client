import { describe, expect, it } from 'vitest'
import {
  connectionId,
  KeychainCredentialVault,
  OryhClientError,
  type KeychainEntry,
} from '../src/index.js'

class FakeKeychain {
  readonly values = new Map<string, string>()
  fail = false

  entry = (service: string, account: string): KeychainEntry => {
    const key = `${service}:${account}`
    return {
      getPassword: () => {
        if (this.fail) throw new Error('native keychain unavailable')
        return this.values.get(key) ?? null
      },
      setPassword: (value) => {
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
  it('stores a credential pair only in the supplied native-keychain entry', async () => {
    const keychain = new FakeKeychain()
    const vault = new KeychainCredentialVault({ serviceName: 'ORYH test', entryFactory: keychain.entry })
    const id = connectionId('oryh-1')

    await vault.write(id, { accessKey: 'private-access-key', refreshToken: 'private-refresh-token', expiresAt: null })

    expect(keychain.values.get('ORYH test:connection:oryh-1')).toBe(
      '{"accessKey":"private-access-key","refreshToken":"private-refresh-token","expiresAt":null}',
    )
    await expect(vault.read(id)).resolves.toEqual({
      accessKey: 'private-access-key', refreshToken: 'private-refresh-token', expiresAt: null,
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
    await expect(vault.write(id, { accessKey: 'a', refreshToken: 'r', expiresAt: null }))
      .rejects.toMatchObject<OryhClientError>({ code: 'credential-store-failed' })
  })
})
