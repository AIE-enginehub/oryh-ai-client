/** Keep an OS authorization dialog from blocking the Harness Host's event loop. */
import { type ChildProcess, fork } from 'node:child_process'
import type { ConnectionId, CredentialPair, CredentialVault } from '@oryh/ai-client-core'
import { OryhClientError } from '@oryh/ai-client-core'

export class LegacyKeychainReader implements CredentialVault {
  readonly #children = new Set<ChildProcess>()
  #closed = false

  constructor(private readonly entry = new URL('./legacy-keychain-reader.js', import.meta.url)) {}

  read(id: ConnectionId): Promise<CredentialPair | undefined> {
    if (this.#closed) return Promise.reject(failure())
    return new Promise((resolve, reject) => {
      // In Desktop process.execPath is the signed Electron executable and the
      // Host already inherits ELECTRON_RUN_AS_NODE. No secret enters argv or env.
      const child = fork(this.entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      this.#children.add(child)
      let settled = false
      const finish = (value?: CredentialPair, failed = false) => {
        if (settled) return
        settled = true
        this.#children.delete(child)
        child.kill()
        if (failed || this.#closed) reject(failure())
        else resolve(value)
      }
      child.once('error', () => finish(undefined, true))
      child.once('exit', () => finish(undefined, true))
      child.once('message', (message: unknown) => {
        if (!isResult(message)) finish(undefined, true)
        else finish(message.credential)
      })
      child.send({ connectionId: id }, error => {
        if (error) finish(undefined, true)
      })
    })
  }

  async write(): Promise<void> {
    throw failure()
  }

  async remove(): Promise<void> {
    throw failure()
  }

  dispose(): void {
    this.#closed = true
    for (const child of this.#children) child.kill()
    this.#children.clear()
  }
}

function failure(): OryhClientError {
  return new OryhClientError('ORYH legacy credential migration failed.', 'credential-store-failed')
}

function isResult(value: unknown): value is { credential: CredentialPair | undefined } {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) return false
  const credential = (value as { credential?: unknown }).credential
  if (credential === undefined) return true
  if (!credential || typeof credential !== 'object') return false
  const pair = credential as CredentialPair
  return (
    typeof pair.accessKey === 'string' &&
    pair.accessKey.length > 0 &&
    typeof pair.refreshToken === 'string' &&
    pair.refreshToken.length > 0 &&
    (pair.expiresAt === null || typeof pair.expiresAt === 'string')
  )
}
