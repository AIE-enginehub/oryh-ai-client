/**
 * Shared vitest configuration for the ORYH client plugins.
 *
 * Two published artifacts cannot be imported under Node: the Harness gateway's client half and the
 * frame's client half are `window.__ModuleLoader__.load` registrations. Tests reach the same code
 * through source instead — the gateway's real stream supervision, and the frame's real hooks — so
 * a page plugin's tests run against what the page really composes with.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = new URL('.', import.meta.url)
export const clientTestConfig = defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-api-gateway/client': fileURLToPath(
        new URL('../packages/client-frame/tests/harness-gateway.ts', here),
      ),
      '@oryh/dsh-client-frame/client': fileURLToPath(new URL('../packages/client-frame/src/client/index.tsx', here)),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
})
export default clientTestConfig
