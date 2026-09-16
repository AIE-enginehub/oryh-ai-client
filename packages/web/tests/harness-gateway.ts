/**
 * Test-only stand-in for `@deepseek-ai/dsh-api-gateway/client`.
 *
 * The published artifact is a `window.__ModuleLoader__.load({id, factory})` registration, not an
 * importable module: in the browser the loader answers the require, but importing it under Node
 * throws immediately on `window` being undefined. These re-exports reach the same classes through
 * the package's own `./src/*` export instead, so tests run Harness's real stream supervision
 * rather than a hand-written stub that would only ever confirm itself.
 *
 * Wired up by the `resolve.alias` entry in `vitest.config.ts`.
 */
export { RemoteSnapshotStream } from '@deepseek-ai/dsh-api-gateway/src/client/snapshot-stream.ts'
export { RemoteStream } from '@deepseek-ai/dsh-api-gateway/src/client/remote-stream.ts'
export { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/src/client/stream-client.ts'
