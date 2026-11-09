/**
 * The shape every generated ORYH Remote call answers in, settled the same way wherever it is called.
 */
import type { ConnectionId } from '@oryh/ai-client-foundation'

export class LocalRemoteError extends Error {
  /**
   * @param code - the ORYH business code when `business`, otherwise the Gateway's own code.
   * @param message - failure text safe to show.
   * @param business - whether the Host refused on purpose, as opposed to a transport or protocol
   * failure. A refusal will not change by asking again, so callers must not retry it.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly business = false,
  ) {
    super(message)
    this.name = 'OryhRemoteError'
  }
}
/**
 * Settle a generated Remote call: the value, or a `LocalRemoteError` carrying the Host's business
 * code when it refused on purpose. Every page plugin's facade goes through this.
 */
export async function unwrap<T>(
  call: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: object } }>,
): Promise<T> {
  const result = await call
  if (!result.ok) {
    const details = result.error.details
    const business = result.error.code === 'oryh/business'
    const code =
      business && details && 'code' in details && typeof details.code === 'string' ? details.code : result.error.code
    throw new LocalRemoteError(code, result.error.message, business)
  }
  return result.value
}
/** The request shape every domain namespace takes: the enterprise connection it is about. */
export const connectionRequest = (connectionId: string): { connectionId: ConnectionId } => ({
  connectionId: connectionId as ConnectionId,
})
