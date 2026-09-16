import { createHash } from 'node:crypto'
import { operationDigestInput } from '@oryh/ai-client-foundation'

export { canonicalJson, operationDigestInput, pageOperation, type OryhOperation } from '@oryh/ai-client-foundation'

/**
 * The digest a page records when the person confirms, and the control process recomputes before it
 * sends: the same method, path and body always give the same digest.
 * @param request - method (GET when absent), path as sent, and body.
 * @returns lowercase hex SHA-256.
 */
export function operationDigest(request: { readonly method?: string; readonly path: string; readonly body?: unknown }): string {
  return createHash('sha256').update(operationDigestInput(request)).digest('hex')
}
