// The error type moved to @oryh/ai-client-foundation so domain packages can throw it
// without depending on the core. Re-exported here so existing imports keep working.

export type { OryhClientErrorCode } from '@oryh/ai-client-foundation'
export { OryhClientError } from '@oryh/ai-client-foundation'
