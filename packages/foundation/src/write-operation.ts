import type { OryhOperation } from './operation.js'

/**
 * One ORYH write, as the domain that performs it describes it: what it is called, what a person reads
 * when it is refused or receipted, and the request that is it.
 *
 * A domain package declares its own writes beside the service that sends them, so the paths, the bodies
 * and the wording stay with the domain. Declaring one opens nothing: only the multi-user server consults
 * these lists, and it decides which domains it admits (docs/37 §5b item 4). The desktop client, where the
 * person is the only authority, never reads them.
 */
export interface WriteOperation {
  /** Stable name for receipts and logs. */
  readonly name: string
  /** What a person reads in a refusal or a receipt. */
  readonly label: string
  readonly method: 'POST' | 'PATCH' | 'DELETE'
  /** Matched against the path without its query string, under `/api/v1`. */
  readonly path: RegExp
  /** Which kinds of write may use this operation. */
  readonly channels: readonly OryhOperation['kind'][]
  /** Further restriction by body, for endpoints shared by several actions. */
  readonly accepts?: (body: unknown) => boolean
}

/** One id in a write's path pattern: a single segment, with no query or fragment in it. */
export const WRITE_PATH_ID = '[^/?#]+'
