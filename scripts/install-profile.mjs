import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(homedir(), 'Library/Application Support/ORYH AI Client/harness')
const profile = 'oryh-web'
const directory = join(home, 'profiles', profile)
const bundle = new URL('../packages/dsh-bundle', import.meta.url).pathname
/** Run the official launcher; `quiet` drops the composed-config dump of the initialization step. */
function dsh(args, quiet = false) {
  const stdio = quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit'
  const result = spawnSync('pnpm', ['exec', 'dsh', ...args], { stdio, env: { ...process.env, DSH_HOME: home } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// The shipped web template supplies the base and web-app layers the ORYH bundle stacks on.
// `--dump-config` initializes the target and prints the composed tree without booting it.
if (!existsSync(directory)) dsh(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], true)
dsh(['plugin', '--profile', profile, 'add', bundle])
console.log(`ORYH Profile installed at ${join(directory, 'package.json')}`)
