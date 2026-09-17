import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = process.cwd()
/** Every Host plugin that publishes a Remote namespace; each gets its own generated artifacts. */
export const REMOTE_PACKAGES = [
  '@oryh/dsh-connection',
  '@oryh/dsh-pane',
  '@oryh/dsh-todos',
  '@oryh/dsh-timesheets',
  '@oryh/dsh-expenses',
  '@oryh/dsh-projects',
  '@oryh/dsh-records',
]
const artifacts = [...new WorkspaceTypertGenerator(root).generate(REMOTE_PACKAGES, ['host'])]

/*
 * Assert what was generated, not just that generation ran.
 *
 * Removing the patch and running this was the way to find out what actually happens: the generator
 * throws "publishes Remote artifacts but has no Remote methods". That is a useful failure, but it
 * is upstream's and it is conditional — it fires because a package lists its Remote artifacts in
 * `files`, and a plugin that does not would get empty output and no error at all. Asserting the
 * positive property here does not depend on either condition holding.
 *
 * Every package must have a unary Remote; the pane must also have the streaming one, which travels a
 * different path through the analyzer (AsyncIterable<T> with a trailing AbortSignal). Validation runs
 * before any write, so a failure leaves the previous artifacts intact.
 */
const missing = []
for (const name of REMOTE_PACKAGES) {
  const artifact = artifacts.find(a => a.package === name)
  const remote = artifact?.remote
  if (remote === undefined) {
    missing.push(`${name}: no Remote client descriptors at all`)
    continue
  }
  if (!/=>\s*Promise<RemoteResult</.test(remote.dts))
    missing.push(`${name}: no unary Remote (=> Promise<RemoteResult<…>>)`)
  if (name === '@oryh/dsh-pane' && !/=>\s*AsyncIterable</.test(remote.dts))
    missing.push(`${name}: no streaming Remote (=> AsyncIterable<…>)`)
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
