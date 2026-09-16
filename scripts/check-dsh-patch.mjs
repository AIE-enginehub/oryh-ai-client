import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'

/*
 * The external-plugin Remote fix is not upstream yet, so a DSH sync drops it silently.
 *
 * An earlier version of this comment claimed the generator then skips the decorated methods
 * without failing. Testing it says otherwise: today it throws "publishes Remote artifacts but has
 * no Remote methods". But that is upstream's check, and it only fires because this package lists
 * its Remote artifacts in `files` — drop those entries and the silent skip comes back. So the
 * protection is real but borrowed, and this guard states the requirement directly rather than
 * depending on it.
 *
 * This used to grep the generator's SOURCE for a comment, which proved nothing about the code that
 * actually runs: the generator executes `lib/index.js`, and patching `src/analyzer.ts` without
 * rebuilding DSH left the guard passing while the executing generator was unpatched. The comment
 * also cannot be looked for in the artifact at all, because the bundler strips comments. So the
 * artifact is checked for emitted code instead, and the patch-versus-tree question is asked
 * separately.
 */

const require = createRequire(import.meta.url)
const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, '../patches/deepseek-harness-external-remote.json'), 'utf8'))
const patch = resolve(import.meta.dirname, '../patches', baseline.patch)
const generatorRoot = dirname(require.resolve('@deepseek-ai/dsh-typert-generator/package.json'))
const harnessRoot = resolve(generatorRoot, '../../..')

/** The entry Node actually loads for the generator, rather than a path we assume. */
const executing = require.resolve('@deepseek-ai/dsh-typert-generator')

const problems = []
const warnings = []

// 1. The executing artifact must carry the fix. This is the invariant that matters: it is both
//    necessary and sufficient for the decorated methods to be generated.
if (!new RegExp(baseline.artifactFingerprint).test(readFileSync(executing, 'utf8'))) {
  problems.push([
    `the built generator at ${executing} does not contain the external-plugin protocol fix`,
    'Apply the patch and REBUILD DSH — patching the source alone is not enough, because the',
    'generator runs from its built output:',
    `  git -C ${harnessRoot} apply ${patch}`,
    `  pnpm -C ${harnessRoot} build`,
  ])
}

// 2. The patch file must still describe the tree it is meant to restore. A reverse dry-run is the
//    precise question: "is exactly this patch currently applied?" It is a maintenance signal, not a
//    build blocker — the artifact check above already decides whether generation can succeed.
const git = spawnSync('git', ['-C', harnessRoot, 'apply', '--check', '--reverse', patch], { encoding: 'utf8' })
if (git.error !== undefined) {
  warnings.push([`could not run git to validate ${relative(process.cwd(), patch)} against the DSH tree: ${git.error.message}`])
} else if (git.status !== 0) {
  warnings.push([
    `${relative(process.cwd(), patch)} no longer matches ${harnessRoot} verbatim.`,
    'The build can still succeed if the fix reached the artifact another way, but the stored patch',
    'has drifted and will not restore the tree after the next DSH sync. Re-export it:',
    `  git -C ${harnessRoot} diff -- ${[baseline.target].flat().join(' ')} > ${patch}`,
    (git.stderr ?? '').trim(),
  ].filter(Boolean))
}

// 3. The pin is informational: an upgrade is allowed, but it is the moment the patch goes stale.
const version = JSON.parse(readFileSync(resolve(harnessRoot, 'package.json'), 'utf8')).version
if (version !== baseline.harnessVersion) {
  warnings.push([
    `DSH is ${version}, but the patch was exported against ${baseline.harnessVersion} (${baseline.harnessCommit}).`,
    `Re-export the patch and update ${relative(process.cwd(), resolve(import.meta.dirname, '../patches', 'deepseek-harness-external-remote.json'))}.`,
  ])
}

for (const warning of warnings) console.error(['DSH patch warning:', ...warning].join('\n  '))
if (problems.length > 0) {
  for (const problem of problems) console.error(['ORYH Remote generation is blocked:', ...problem].join('\n  '))
  process.exit(1)
}
