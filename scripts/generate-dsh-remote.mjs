import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const artifacts = [...new WorkspaceTypertGenerator(root).generate(['@oryh/dsh-host'], ['host'])]

/*
 * Assert what was generated, not just that generation ran.
 *
 * Removing the patch and running this was the way to find out what actually happens: the generator
 * throws "publishes Remote artifacts but has no Remote methods". That is a useful failure, but it
 * is upstream's and it is conditional — it fires because this package lists its Remote artifacts in
 * `files`, and a plugin that does not would get empty output and no error at all. Asserting the
 * positive property here does not depend on either condition holding.
 *
 * Both shapes are checked because they travel different paths through the analyzer: a unary method
 * returns Promise<RemoteResult<T>>, a streaming one returns AsyncIterable<T> with a trailing
 * AbortSignal. Validation runs before any write, so a failure leaves the previous artifacts intact.
 */
const remote = artifacts.find(artifact => artifact.remote)?.remote
const missing = []
if (remote === undefined) missing.push('no Remote client descriptors at all')
else {
  if (!/=>\s*Promise<RemoteResult</.test(remote.dts)) missing.push('no unary Remote (=> Promise<RemoteResult<…>>)')
  if (!/=>\s*AsyncIterable</.test(remote.dts)) missing.push('no streaming Remote (=> AsyncIterable<…>)')
}
if (missing.length > 0) {
  console.error('ORYH Remote generation produced incomplete descriptors:')
  for (const entry of missing) console.error(`  - ${entry}`)
  console.error('  This is what a missing external-plugin protocol patch looks like: generation')
  console.error('  succeeds and quietly emits nothing for the decorated methods.')
  console.error('  Check: node scripts/check-dsh-patch.mjs')
  process.exit(1)
}

for (const artifact of artifacts) {
  const output = resolve(root, artifact.packageRoot, 'lib')
  await writeFile(resolve(output, `typert.${artifact.face}.js`), artifact.js)
  await writeFile(resolve(output, `typert.${artifact.face}.d.ts`), artifact.dts)
  if (artifact.remote) {
    await writeFile(resolve(output, 'typert.remote-client.js'), artifact.remote.js)
    await writeFile(resolve(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
    await writeFile(resolve(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  }
}
