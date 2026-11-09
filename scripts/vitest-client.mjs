/** Client tests use Harness's public Node Gateway entry and one React instance. */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = new URL('.', import.meta.url)
const gateway = createRequire(new URL('../packages/client-frame/package.json', here)).resolve(
  '@deepseek-ai/dsh-api-gateway/client',
)
export const clientTestConfig = defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    // Harness's primitives are linked from its own checkout, which has a React of its own. A component
    // drawn with them would run on that copy while the test renders with this one — two Reacts, and
    // every hook fails. One copy, whoever asks.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@deepseek-ai/dsh-api-gateway/client': gateway,
      // The kit is bundled into each plugin; tests read its source, so no build stands between an edit and a run.
      '@oryh/ai-client-kit/styles.css': fileURLToPath(new URL('../packages/client-kit/src/styles.css', here)),
      '@oryh/ai-client-kit/dictionary': fileURLToPath(new URL('../packages/client-kit/src/dictionary.ts', here)),
      '@oryh/ai-client-kit/testing': fileURLToPath(new URL('../packages/client-kit/src/pane-test.ts', here)),
      '@oryh/ai-client-kit': fileURLToPath(new URL('../packages/client-kit/src/index.ts', here)),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
})
export default clientTestConfig
