import { readFile, rm } from 'node:fs/promises'
import type { CredentialPair } from './credentials.js'
import { normalizeOrigin } from './connections.js'
import { OryhClientError } from './errors.js'

/** A credential issued outside this Host, waiting to become a connection. */
export interface HandedOffCredential {
  readonly origin: string
  readonly credential: CredentialPair
}

/**
 * Where a trusted process in the same deployment leaves a credential for the Host to adopt.
 *
 * The container's login gateway signs the person in with ORYH's OAuth flow before the client opens;
 * this is how that one sign-in also becomes the enterprise connection, so nobody authorizes twice.
 */
export interface CredentialHandoff {
  /** Take the waiting credential, if any; a taken credential is never offered again. */
  take(): Promise<HandedOffCredential | undefined>
}

/**
 * A handoff through one private file, removed as soon as it is read.
 * @param path - absolute file the gateway writes with mode 0600.
 * @returns a handoff that is empty while the file does not exist.
 */
export function fileCredentialHandoff(path: string): CredentialHandoff {
  return {
    async take() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      // Removed before decoding: a malformed file must not be retried on every connection listing.
      await rm(path, { force: true })
      return decodeHandoff(text)
    },
  }
}

function decodeHandoff(text: string): HandedOffCredential {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalid()
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const { origin, accessKey, refreshToken, expiresAt } = value as Record<string, unknown>
  if (typeof origin !== 'string' || typeof accessKey !== 'string' || !accessKey || typeof refreshToken !== 'string' || !refreshToken) throw invalid()
  if (expiresAt !== null && expiresAt !== undefined && typeof expiresAt !== 'string') throw invalid()
  return { origin: normalizeOrigin(origin), credential: { accessKey, refreshToken, expiresAt: expiresAt ?? null } }
}

function invalid(): OryhClientError {
  return new OryhClientError('The handed-off ORYH credential is malformed.', 'invalid-response')
}
