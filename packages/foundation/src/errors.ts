/** Error reported by ORYH or a local adapter without exposing credential material. */
export class OryhClientError extends Error {
  constructor(
    message: string,
    readonly code: OryhClientErrorCode,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OryhClientError'
  }
}

/** Stable categories used by the UI and Host integration. */
export type OryhClientErrorCode =
  | 'expense-conflict'
  | 'timesheet-conflict'
  | 'authentication-failed'
  | 'connection-not-found'
  | 'connection-identity-mismatch'
  | 'connection-store-failed'
  | 'connection-verification-required'
  | 'credential-store-failed'
  | 'cross-connection-result'
  | 'employee-required'
  | 'invalid-response'
  | 'operation-not-found'
  | 'refresh-failed'
  | 'request-failed'
  | 'unsupported-origin'
