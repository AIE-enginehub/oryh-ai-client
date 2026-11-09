import { readFile, rm } from 'node:fs/promises'
import { normalizeOrigin } from './connections.js'
import type { CredentialPair } from './credentials.js'
import type { ConnectionAdmission } from './device-flow.js'
import { OryhClientError } from './errors.js'

/** A credential issued outside this Host, waiting to become a connection. */
export interface HandedOffCredential {
  readonly origin: string
  readonly credential: CredentialPair
  /**
   * The Host is now this person's alone: every other connection it holds is forgotten once this one is
   * verified. A single-user container's gateway sets it, so switching accounts leaves nobody else's
   * credential behind.
   */
  readonly sole?: boolean
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
  const { origin, accessKey, refreshToken, expiresAt, sole } = value as Record<string, unknown>
  if (
    typeof origin !== 'string' ||
    typeof accessKey !== 'string' ||
    !accessKey ||
    typeof refreshToken !== 'string' ||
    !refreshToken
  )
    throw invalid()
  if (expiresAt !== null && expiresAt !== undefined && typeof expiresAt !== 'string') throw invalid()
  return {
    origin: normalizeOrigin(origin),
    credential: { accessKey, refreshToken, expiresAt: expiresAt ?? null },
    ...(sole === true ? { sole: true } : {}),
  }
}

function invalid(): OryhClientError {
  return new OryhClientError('The handed-off ORYH credential is malformed.', 'invalid-response')
}

/**
 * Admit only the person a single-user deployment belongs to, as its sign-in gateway recorded them.
 *
 * The gateway writes the owner on the first sign-in: the ORYH they signed in to, their tenant and their
 * user id. While nobody has signed in there is no owner yet and nobody to refuse.
 * @param path - absolute path of the owner file.
 * @returns an admission that throws for any other account.
 */
export function ownerAdmission(path: string): ConnectionAdmission {
  return async (origin, identity) => {
    let owner: { origin?: unknown; tenantId?: unknown; userId?: unknown; email?: unknown }
    try {
      owner = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new OryhClientError('无法确认这个客户端属于谁，没有连接。', 'request-failed')
    }
    if (owner.origin === origin && owner.tenantId === identity.tenant.id && owner.userId === identity.user.id) return
    const whose = typeof owner.email === 'string' && owner.email ? owner.email : '另一个 ORYH 账号'
    throw new OryhClientError(
      `这是 ${whose} 的单用户客户端，刚才授权的是 ${identity.user.email}，没有连接。请在 ORYH 里换成 ${whose} 登录后再授权。`,
      // Its own code: the sentence above says who and what to do, and a client shows it as written —
      // under the general mismatch code it was replaced by words about a credential gone astray.
      'connection-owner-mismatch',
    )
  }
}
