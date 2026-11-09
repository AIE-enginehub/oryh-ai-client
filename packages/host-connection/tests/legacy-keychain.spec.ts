import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionId } from '@oryh/ai-client-core'
import { afterEach, expect, it } from 'vitest'
import { LegacyKeychainReader } from '../src/legacy-keychain.js'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

async function fixture(mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'oryh-keychain-wait-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const reader = new LegacyKeychainReader(new URL('./fixtures/keychain-reader.mjs', import.meta.url))
  cleanup.push(() => reader.dispose())
  const marker = join(directory, 'waiting')
  const release = join(directory, 'release')
  const result = reader.read(connectionId(JSON.stringify({ marker, release, mode })))
  // Attach rejection immediately, including the crash/denial cases.
  void result.catch(() => {})
  for (let attempt = 0; ; attempt++) {
    try {
      await access(marker)
      break
    } catch {
      if (attempt > 200) throw new Error('Reader did not start')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return { reader, result, release: () => writeFile(release, 'authorized') }
}

it('serves Host startup requests while native authorization is synchronously blocked', async () => {
  const f = await fixture()
  const server = createServer((_request, response) => response.end('settings-ready'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  let finished = false
  void f.result.then(() => {
    finished = true
  })
  for (let n = 0; n < 3; n++) {
    const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(200) })
    expect(await response.text()).toBe('settings-ready')
  }
  expect(finished).toBe(false)
  await f.release()
  expect(await f.result).toEqual({ accessKey: 'test-access', refreshToken: 'test-refresh', expiresAt: null })
})

it.each(['denied', 'exit', 'malformed'])('fails closed on %s without exposing a native diagnostic', async mode => {
  const f = await fixture(mode)
  await f.release()
  await expect(f.result).rejects.toMatchObject({
    code: 'credential-store-failed',
    message: 'ORYH legacy credential migration failed.',
  })
})

it('preserves missing credentials as absent', async () => {
  const f = await fixture('missing')
  await f.release()
  expect(await f.result).toBeUndefined()
})

it('terminates a pending authorization reader on Host disposal', async () => {
  const f = await fixture()
  f.reader.dispose()
  await expect(f.result).rejects.toMatchObject({ code: 'credential-store-failed' })
  await expect(f.reader.read(connectionId('closed'))).rejects.toMatchObject({ code: 'credential-store-failed' })
  await expect(f.reader.write()).rejects.toMatchObject({ code: 'credential-store-failed' })
  await expect(f.reader.remove()).rejects.toMatchObject({ code: 'credential-store-failed' })
})
