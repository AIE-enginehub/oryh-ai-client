/** Assemble the pinned official Desktop shell with ORYH's external plugin bundle. No upstream source edits. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adaptDesktopEntry } from '../deploy/desktop/shell-adapter.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const harness = resolve(root, '../deepseek-harness')
const desktop = join(harness, 'apps/desktop')
const baseline = JSON.parse(readFileSync(join(root, 'patches/deepseek-harness-external-remote.json'), 'utf8'))
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Could not read source revision')
  return result.stdout.trim()
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This build targets Apple Silicon macOS')
const harnessCommit = git(harness, 'rev-parse', 'HEAD')
if (!harnessCommit.startsWith(baseline.harnessCommit)) throw new Error('Run harness:setup for the pinned Harness first')
run('node', ['scripts/check-dsh-patch.mjs'])
if (!process.argv.includes('--reuse-shell')) run('pnpm', ['run', 'package:mac:arm64:unsigned', '--dir'], desktop)
if (!process.argv.includes('--reuse-client')) run('pnpm', ['run', 'build'])

const commit = git(root, 'rev-parse', 'HEAD')
const out = join(root, 'dist/mac-arm64')
const app = join(out, 'ORYH AI Client.app')
const stage = join(out, 'app-content')
mkdirSync(out, { recursive: true })
const shell = join(desktop, '.desktop-build/targets/mac-arm64/unsigned-artifacts/mac-arm64/DeepSeek Harness.app')
if (!existsSync(shell)) throw new Error(`Official shell is missing: ${shell}`)
rmSync(app, { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
run('ditto', [shell, app])
const require = createRequire(join(desktop, 'package.json'))
const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar')
const resources = join(app, 'Contents/Resources')
asar.extractAll(join(resources, 'app.asar'), stage)
const runtime = join(stage, 'dsh')
const descriptorPath = join(runtime, 'desktop-runtime.json')
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
if (descriptor.release.version !== baseline.harnessVersion || descriptor.arch !== 'arm64')
  throw new Error('Shell runtime does not match the pinned version')

const workspace = new Map(
  readdirSync(join(root, 'packages')).flatMap(dir => {
    const path = join(root, 'packages', dir)
    const file = join(path, 'package.json')
    if (!existsSync(file)) return []
    return [[JSON.parse(readFileSync(file, 'utf8')).name, path]]
  }),
)
const installed = new Set()
function sourceOf(from, name, spec) {
  if (workspace.has(name)) return workspace.get(name)
  if (spec.startsWith('link:')) return realpathSync(resolve(from, spec.slice(5)))
  const anchor = createRequire(join(from, 'package.json'))
  // ESM-only packages may export neither their manifest nor a CommonJS root entry.
  for (const modules of anchor.resolve.paths(name) ?? []) {
    const candidate = join(modules, name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  try {
    return dirname(anchor.resolve(`${name}/package.json`))
  } catch {}
  let path = dirname(anchor.resolve(name))
  while (path !== dirname(path)) {
    const file = join(path, 'package.json')
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return path
    path = dirname(path)
  }
  throw new Error(`Cannot resolve ${name}`)
}
function install(from, modules) {
  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
  const target = join(modules, manifest.name)
  const key = `${manifest.name}@${manifest.version}:${modules}`
  if (installed.has(key)) return
  installed.add(key)
  if (existsSync(join(target, 'package.json'))) {
    const existing = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    if (existing.version === manifest.version) return
    throw new Error(`Runtime dependency mismatch: ${manifest.name} ${existing.version} / ${manifest.version}`)
  }
  mkdirSync(target, { recursive: true })
  if (manifest.name.startsWith('@oryh/')) {
    // Product packages ship compiled public entries, never source, private server packages or local configuration.
    if (existsSync(join(from, 'lib')))
      cpSync(join(from, 'lib'), join(target, 'lib'), { recursive: true, dereference: true })
    if (existsSync(join(from, 'cordis.patch.yml')))
      cpSync(join(from, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'))
  } else {
    cpSync(from, target, {
      recursive: true,
      dereference: true,
      filter: path => {
        const part = basename(path)
        return part !== 'node_modules' && part !== '.git' && !part.startsWith('.env')
      },
    })
  }
  const dependencies = {}
  for (const [name, spec] of Object.entries(manifest.optionalDependencies ?? {})) {
    let source
    try {
      source = sourceOf(from, name, spec)
    } catch {
      continue // Other platforms' optional binaries are not installed on this build machine.
    }
    const optional = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    if (optional.os && !optional.os.includes('darwin')) continue
    if (optional.cpu && !optional.cpu.includes('arm64')) continue
    install(source, modules)
  }
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    const source = sourceOf(from, name, spec)
    const dependency = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    dependencies[name] = dependency.version
    const shared = join(runtime, 'node_modules', name, 'package.json')
    const sharedVersion = existsSync(shared) ? JSON.parse(readFileSync(shared, 'utf8')).version : undefined
    if (sharedVersion !== undefined && sharedVersion !== dependency.version && name.startsWith('@deepseek-ai/'))
      throw new Error(`Harness package version mismatch: ${name}`)
    install(
      source,
      sharedVersion === undefined || sharedVersion === dependency.version
        ? join(runtime, 'node_modules')
        : join(target, 'node_modules'),
    )
  }
  const shipped = { ...manifest, dependencies }
  delete shipped.devDependencies
  delete shipped.scripts
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(shipped, null, 2)}\n`)
  if (modules === join(runtime, 'node_modules'))
    descriptor.sharedPackages.push({
      name: manifest.name,
      version: manifest.version,
      path: `node_modules/${manifest.name}`,
    })
}
install(workspace.get('@oryh/dsh-bundle'), join(runtime, 'node_modules'))

// Brand the generated loading document too, before ORYH's client plugins have mounted.
const frontend = join(runtime, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')
for (const file of [
  join(frontend, 'index.html'),
  ...readdirSync(join(frontend, 'assets'))
    .filter(name => name.endsWith('.js'))
    .map(name => join(frontend, 'assets', name)),
]) {
  const text = readFileSync(file, 'utf8')
  const branded = text
    .replaceAll('DeepSeek Harness', 'ORYH AI Client')
    .replaceAll('"HARNESS"', '"ORYH"')
    .replaceAll("'HARNESS'", "'ORYH'")
  if (text !== branded) writeFileSync(file, branded)
}
for (const name of ['favicon.svg', 'favicon-dark.svg'])
  cpSync(join(root, 'deploy/desktop/icon.svg'), join(frontend, name))

const files = []
function inventory(path, prefix = '') {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (name === 'desktop-runtime.json') continue
    const file = join(path, entry.name)
    if (entry.isDirectory()) inventory(file, `${name}/`)
    else {
      const body = readFileSync(file)
      files.push({
        path: name,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        executable: Boolean(statSync(file).mode & 0o111),
      })
    }
  }
}
inventory(runtime)
descriptor.files = files.sort((a, b) => a.path.localeCompare(b.path))
writeFileSync(descriptorPath, JSON.stringify(descriptor))
for (const name of ['account-profiles', 'profile-control'])
  cpSync(join(root, `deploy/desktop/${name}.mjs`), join(stage, `oryh-${name}.mjs`))
cpSync(join(root, 'deploy/desktop/bootstrap.mjs'), join(stage, 'oryh-bootstrap.mjs'))
cpSync(join(root, 'deploy/desktop/profile-patch.mjs'), join(stage, 'oryh-profile-patch.mjs'))
const build = {
  clientDirty: git(root, 'status', '--porcelain').length > 0,
  clientCommit: commit,
  harnessCommit,
  harnessVersion: baseline.harnessVersion,
  builtAt: new Date().toISOString(),
  localTest: true,
}
writeFileSync(join(stage, 'oryh-build.json'), JSON.stringify(build, null, 2))
const manifestPath = join(stage, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.dshBuildCommit !== harnessCommit)
  throw new Error('Desktop shell was built from a different Harness commit')
manifest.name = '@oryh/desktop'
manifest.productName = 'ORYH AI Client'
manifest.main = 'oryh-bootstrap.mjs'
manifest.dshDesktopAppId = 'ai.oryh.client'
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
// Distribution branding of generated resources only. The upstream checkout and its patch set stay intact.
for (const file of ['lib/main.js', 'lib/welcome/welcome.js']) {
  const path = join(stage, file)
  let source = readFileSync(path, 'utf8').replaceAll('DeepSeek Harness', 'ORYH AI Client')
  if (file === 'lib/main.js') source = adaptDesktopEntry(source)
  writeFileSync(path, source)
}
rmSync(join(resources, 'app.asar'), { force: true })
rmSync(join(resources, 'app.asar.unpacked'), { recursive: true, force: true })
await asar.createPackageWithOptions(stage, join(resources, 'app.asar'), {
  unpack:
    '{**/*.{node,dylib,dll,so,exe},**/*.so.*,**/spawn-helper,**/@vscode/ripgrep-*/bin/rg,**/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/**/*}',
})

const sharp = require('sharp')
const iconset = join(out, 'oryh.iconset')
mkdirSync(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2]) {
    await sharp(join(root, 'deploy/desktop/icon.svg'))
      .resize(size * scale)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
  }
run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')])
await sharp(join(root, 'deploy/desktop/icon.svg')).resize(512).png().toFile(join(resources, 'icon.png'))
const plist = join(app, 'Contents/Info.plist')
const frameworks = join(app, 'Contents/Frameworks')
for (const entry of readdirSync(frameworks)) {
  if (!entry.startsWith('DeepSeek Harness Helper') || !entry.endsWith('.app')) continue
  const helper = join(frameworks, entry)
  const helperPlist = join(helper, 'Contents/Info.plist')
  const oldName = entry.slice(0, -4)
  const newName = oldName.replace('DeepSeek Harness', 'ORYH AI Client')
  renameSync(join(helper, 'Contents/MacOS', oldName), join(helper, 'Contents/MacOS', newName))
  for (const key of ['CFBundleExecutable', 'CFBundleName', 'CFBundleDisplayName']) {
    const present = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, helperPlist])
    if (present.status === 0) run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${newName}`, helperPlist])
  }
  renameSync(helper, join(frameworks, `${newName}.app`))
}
const integrity = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ElectronAsarIntegrity', plist])
if (integrity.status === 0) {
  const hash = createHash('sha256')
    .update(asar.getRawHeader(join(resources, 'app.asar')).headerString)
    .digest('hex')
  run('/usr/libexec/PlistBuddy', ['-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`, plist])
}
for (const [key, value] of Object.entries({
  CFBundleIdentifier: 'ai.oryh.client',
  CFBundleName: 'ORYH AI Client',
  CFBundleDisplayName: 'ORYH AI Client',
})) {
  run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
}
run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleExecutable ORYH AI Client', plist])
renameSync(join(app, 'Contents/MacOS/DeepSeek Harness'), join(app, 'Contents/MacOS/ORYH AI Client'))
run('codesign', ['--force', '--deep', '--sign', '-', app])
run('codesign', ['--verify', '--deep', '--strict', app])
run(
  join(app, 'Contents/MacOS/ORYH AI Client'),
  [
    '--input-type=module',
    '-e',
    `
  import {createRequire} from 'node:module';
  import {pathToFileURL} from 'node:url';
  import {readFileSync} from 'node:fs';
  import {createHash} from 'node:crypto';
  const require = createRequire(${JSON.stringify(join(resources, 'app.asar/dsh/package.json'))});
  await import(pathToFileURL(require.resolve('@oryh/ai-client-core')).href);
  await import(pathToFileURL(require.resolve('@oryh/dsh-connection')).href);
  require('@napi-rs/keyring');
  const {desktopProfilePatch} = await import(pathToFileURL(${JSON.stringify(join(resources, 'app.asar/oryh-profile-patch.mjs'))}).href);
  const yaml = require('js-yaml');
  for (const text of ['# fresh profile\\n[]\\n', '# keep custom settings\\n- id: ui-chat\\n  config: {transcriptView: standard}\\n']) {
    const result = desktopProfilePatch(text, '/tmp/oryh-business');
    const rows = yaml.load(result);
    if (!Array.isArray(rows) || rows.at(-1).config.dataDirectory !== '/tmp/oryh-business' || rows.at(-1).config.developmentOnly !== true) throw new Error('Invalid desktop Profile patch');
    if (desktopProfilePatch(result, '/tmp/oryh-business') !== result) throw new Error('Profile patch is not idempotent');
  }
  const root = ${JSON.stringify(join(resources, 'app.asar/dsh'))};
  const inventory = JSON.parse(readFileSync(root + '/desktop-runtime.json', 'utf8'));
  for (const file of inventory.files) {
    const body = readFileSync(root + '/' + file.path);
    if (body.length !== file.bytes || createHash('sha256').update(body).digest('hex') !== file.sha256) throw new Error('Runtime integrity mismatch: ' + file.path);
  }
  console.info('ORYH packaged runtime file hashes verified:', inventory.files.length);
  console.info('ORYH packaged native keyring and Host plugin imports passed');
`,
  ],
  '/tmp',
  { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin' },
)
const image = join(out, `oryh-ai-client-${commit.slice(0, 7)}-mac-arm64.dmg`)
const dmg = join(out, 'dmg-content')
rmSync(dmg, { recursive: true, force: true })
mkdirSync(dmg)
run('ditto', [app, join(dmg, basename(app))])
run('ln', ['-s', '/Applications', join(dmg, 'Applications')])
run('hdiutil', ['create', '-ov', '-format', 'UDZO', '-volname', 'ORYH AI Client', '-srcfolder', dmg, image])
rmSync(dmg, { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
writeFileSync(
  join(out, 'build.json'),
  JSON.stringify(
    { ...build, app, image, sha256: createHash('sha256').update(readFileSync(image)).digest('hex') },
    null,
    2,
  ),
)
console.info(`APP: ${app}\nDMG: ${image}`)
