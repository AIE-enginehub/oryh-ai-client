/** Product identity and an external Profile; the official Harness shell owns windows and Host lifecycle. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app } from 'electron'
import { accountProfiles } from './oryh-account-profiles.mjs'
import { profileControl } from './oryh-profile-control.mjs'
import { desktopProfilePatch } from './oryh-profile-patch.mjs'

const data = process.env.ORYH_DESKTOP_DATA_DIR || join(app.getPath('appData'), 'ORYH AI Client')
mkdirSync(data, { recursive: true, mode: 0o700 })
app.setName('ORYH AI Client')
const profiles = accountProfiles(data)
mkdirSync(join(profiles.current.root, 'electron'), { recursive: true, mode: 0o700 })
mkdirSync(join(data, 'logs'), { recursive: true, mode: 0o700 })
app.setPath('userData', join(profiles.current.root, 'electron'))
app.setPath('logs', join(data, 'logs'))
process.env.DSH_HOME = profiles.current.home
process.env.DSH_AGENTS_HOME = join(profiles.current.root, 'agents')
process.env.ORYH_LOCAL_WORKSPACE = profiles.current.workspace
process.env.ORYH_DESKTOP_CONNECTION_ID = profiles.current.connectionId || ''
const control = await profileControl(
  profiles,
  commit =>
    new Promise((resolve, reject) => {
      if (!app.emit('oryh-switch-profile', { commit, resolve, reject })) reject(new Error('Desktop is not ready'))
    }),
)
process.env.ORYH_DESKTOP_PROFILE_SOCKET = control.socket

const runtime = createRequire(new URL('./dsh/package.json', import.meta.url))
const { initProfile, PROFILE_TEMPLATES } = await import(
  pathToFileURL(runtime.resolve('@deepseek-ai/dsh-app-boot')).href
)
const profile = join(process.env.DSH_HOME, 'profiles', 'desktop')
initProfile(profile, [...PROFILE_TEMPLATES.web.bundles, '@oryh/dsh-bundle'])
const patch = join(profile, 'cordis.patch.yml')
const before = readFileSync(patch, 'utf8')
const configured = desktopProfilePatch(
  before,
  join(data, 'business'),
  join(data, 'harness', '.credentials.yaml'),
  profiles.current.workspace,
)
if (configured !== before) writeFileSync(patch, configured, { mode: 0o600 })
const path = join(profile, 'package.json')
const manifest = JSON.parse(readFileSync(path, 'utf8'))
if (!manifest.dsh.profile.bundles.includes('@oryh/dsh-bundle')) {
  manifest.dsh.profile.bundles.push('@oryh/dsh-bundle')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
}

// A diagnostic marker contains paths and versions only; credentials stay in the Host's providers.
const buildPath = fileURLToPath(new URL('./oryh-build.json', import.meta.url))
if (existsSync(buildPath)) console.info('ORYH desktop build', JSON.parse(readFileSync(buildPath, 'utf8')))
await import('./lib/main.js')
