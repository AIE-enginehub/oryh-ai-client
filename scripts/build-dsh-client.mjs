import { build } from 'esbuild'
import { writeFile, mkdir } from 'node:fs/promises'
const root = new URL('../packages/web/', import.meta.url).pathname
await mkdir(root + 'lib', { recursive: true })
await build({ entryPoints: [root + 'src/index.ts'], outfile: root + 'lib/index.js', format: 'esm', platform: 'node' })
const result = await build({
  entryPoints: [root + 'src/client/index.tsx'], bundle: true, write: false,
  platform: 'browser', format: 'cjs', jsx: 'automatic', target: 'es2022',
  // Everything here is answered by the loader's module table at factory time instead of being
  // bundled. The gateway entry is what makes Harness's public stream classes reachable as values
  // (verified at 0.1.5-rc.2): its built artifact is a `__ModuleLoader__.load` registration with no
  // ESM exports, so bundling it yields `undefined` imports — the loader strips the `/client`
  // suffix and answers the require. See docs/14, "跨插件值引用".
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-api-gateway/client'],
  loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
})
await writeFile(root + 'lib/client.js', `window.__ModuleLoader__.load({id:"@oryh/dsh-client",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`)
