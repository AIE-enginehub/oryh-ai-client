/**
 * Build one ORYH client plugin the way Harness's own `tsdown.client.ts` preset does, from outside
 * the Harness workspace: a Node loader entry, and a browser bundle registered as a closure factory
 * (`window.__ModuleLoader__.load({id, factory})`) that resolves its externals through the loader's
 * module table.
 *
 * The preset itself cannot be reused here: it looks every package up by name in the Harness
 * repository's own `packages/*\/*\/package.json`. So its two rules are mirrored instead. The platform
 * modules (React, Cordis, the client store and slots) are always external; everything the package
 * requests in `dsh.client.external` is external too, so a page plugin shares the frame's one bundle
 * (`@oryh/dsh-client-frame/client`) rather than inlining a second React context of its own;
 * everything else is bundled.
 *
 * Run from the package directory: `node ../../scripts/build-dsh-client.mjs`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

/** Mirrors `PLATFORM_MODULES` in Harness's `packages/client/web/src/platform.ts`. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const root = process.cwd()
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const id = manifest.name
const requested = manifest.dsh?.client?.external ?? []
const external = [...PLATFORM_MODULES, ...requested]
await mkdir(resolve(root, 'lib'), { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  format: 'esm',
  platform: 'node',
})
const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  target: 'es2022',
  external,
  // Smaller without becoming unreadable: names stay, whitespace and syntax sugar go.
  minifyWhitespace: true,
  minifySyntax: true,
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
await writeFile(
  resolve(root, 'lib/client.js'),
  `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`,
)
