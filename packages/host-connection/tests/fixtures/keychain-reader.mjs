import { existsSync, writeFileSync } from 'node:fs'

process.once('message', ({ connectionId }) => {
  const { marker, release, mode } = JSON.parse(connectionId)
  writeFileSync(marker, 'waiting')
  // Deliberately block this process like the synchronous native keyring API.
  while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  if (mode === 'exit') process.exit(1)
  const message =
    mode === 'denied'
      ? { ok: false }
      : mode === 'malformed'
        ? { ok: true, credential: { accessKey: 'invalid' } }
        : mode === 'missing'
          ? { ok: true }
          : { ok: true, credential: { accessKey: 'test-access', refreshToken: 'test-refresh', expiresAt: null } }
  process.send(message, () => process.disconnect())
})
