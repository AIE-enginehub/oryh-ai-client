import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // The gateway's published client artifact is a `__ModuleLoader__.load` registration and
      // throws on import outside the browser. Point tests at the same classes from source so the
      // real supervision runs; see tests/harness-gateway.ts.
      '@deepseek-ai/dsh-api-gateway/client': fileURLToPath(new URL('tests/harness-gateway.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
})
