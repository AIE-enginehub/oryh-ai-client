import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * Prepares the DeepSeek Harness checkout this repository builds against: the sibling directory
 * `../deepseek-harness`, at the commit our patch was exported against, with the patch applied, its
 * dependencies installed and its packages built (patches/README.md).
 *
 * The Harness is someone else's repository. Nothing is committed or pushed there: the patch lives in
 * this repository and is applied to each person's own checkout. A checkout that holds other work is
 * left alone, and the script says what it found instead.
 *
 * Usage: pnpm run harness:setup
 */

// Asked first: an older Node.js fails further down in ways that say nothing about the cause.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(
    `harness setup: Node.js 24 is required, this is ${process.versions.node}. Switch first, e.g. \`nvm use\`.`,
  )
  process.exit(1)
}

const repository = resolve(import.meta.dirname, '..')
const baseline = JSON.parse(readFileSync(resolve(repository, 'patches/deepseek-harness-external-remote.json'), 'utf8'))
const patch = resolve(repository, 'patches', baseline.patch)
const harness = resolve(repository, '../deepseek-harness')

function fail(...lines) {
  console.error(['harness setup:', ...lines].join('\n  '))
  process.exit(1)
}
/** Runs a command in the Harness checkout, showing what it prints; stops the setup when it fails. */
function run(command, args, cwd = harness) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) fail(`could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed in ${cwd}`)
}
/** What a git command in the Harness checkout prints, or undefined when it fails. */
function git(...args) {
  const result = spawnSync('git', ['-C', harness, ...args], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

// 1. The checkout itself, at the commit the patch was exported against.
if (!existsSync(harness)) {
  run('git', ['clone', baseline.harnessRepository, harness], repository)
  run('git', ['checkout', '--detach', baseline.harnessCommit])
}
const head = git('rev-parse', 'HEAD')
if (head === undefined) fail(`${harness} is not a git checkout of DeepSeek Harness.`)
if (!head.startsWith(baseline.harnessCommit))
  fail(
    `${harness} is at ${head.slice(0, 10)}, but this repository builds against DSH ${baseline.harnessVersion} (${baseline.harnessCommit}).`,
    'Move it there yourself, so nothing you have in that checkout is lost:',
    `  git -C ${harness} fetch origin && git -C ${harness} checkout --detach ${baseline.harnessCommit}`,
  )

// 2. Our patch: applied when it is not there yet, accepted as is when it already is.
if (git('apply', '--check', '--reverse', patch) !== undefined) console.log('\nThe patch is already applied.')
else if (git('apply', '--check', patch) !== undefined) run('git', ['apply', patch])
else
  fail(
    `patches/${baseline.patch} neither applies to ${harness} nor is already applied there.`,
    'The files it changes hold something else. See what:',
    `  git -C ${harness} status --short -- ${[baseline.target].flat().join(' ')}`,
  )

// 3. Dependencies and build, run inside the checkout: pnpm takes its version from the directory it runs
//    in, and the Harness pins a different one than this repository does. The build must come after the
//    patch, because the generator this repository calls runs from the Harness's build output.
run('pnpm', ['install', '--frozen-lockfile'])
run('pnpm', ['build'])

console.log(`\nDeepSeek Harness ${baseline.harnessVersion} is ready in ${harness}. Next, in this repository:`)
console.log('  pnpm install && pnpm run verify')
