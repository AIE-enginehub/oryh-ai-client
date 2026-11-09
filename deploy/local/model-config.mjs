// The model is a deployment decision, not something each person configures.
//
// The deployment supplies the endpoint, key, model and reasoning effort through the container
// environment (compose.yaml, fed from `.env`), and @oryh/dsh-bundle declares the model route from that
// environment. The key stays in the inherited environment, which Harness reads first and treats as
// read-only, and which it scrubs from the shell the agent runs. This script runs at every start, before
// DSH boots, and makes that choice authoritative:
//   - the home patch ($DSH_HOME/cordis.patch.yml), which sits above every profile, pins the default model
//     and removes the Models settings page, the per-session model picker and provider sign-in, so there
//     is nothing to configure in the browser; the settings editor refuses to write what it shadows;
//   - the profile patch is left to the person: since DSH 0.1.7 the workbench saves settings there. The
//     one this script wrote before that held only the deployment's rows, and is emptied once;
//   - any model section a person saved in the old settings.yaml is removed before DSH imports that file
//     into the profile, where it would otherwise outrank the deployment's route.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const env = process.env
if (!env.DEEPSEEK_API_KEY?.trim())
  throw new Error('DEEPSEEK_API_KEY is required: set ORYH_MODEL_API_KEY in .env next to compose.yaml')
const model = env.ORYH_MODEL?.trim() || 'deepseek-v4-flash'
const effort = env.ORYH_MODEL_REASONING_EFFORT?.trim() || 'high'
if (!['off', 'low', 'high', 'max'].includes(effort))
  throw new Error('ORYH_MODEL_REASONING_EFFORT must be off, low, high or max')
if (env.DEEPSEEK_BASE_URL) new URL(env.DEEPSEEK_BASE_URL)

const home = env.DSH_HOME
if (!home) throw new Error('DSH_HOME is required')
const YAML = createRequire(
  join(env.DSH_HARNESS_ROOT ?? '/opt/deepseek-harness', 'packages/settings/settings/package.json'),
)('yaml')

const written = '# Written by deploy/local/model-config.mjs at every container start; edits here are replaced.\n'
writeFileSync(
  join(home, 'cordis.patch.yml'),
  written +
    YAML.stringify([
      // A patch replaces the row's whole config, so both keys are restated.
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
      { id: 'ui-settings-models', disabled: true },
      { id: 'ui-model-selection', disabled: true },
      { id: 'authorization', disabled: true },
      { id: 'deepseek-account', disabled: true },
      { id: 'account-controller', disabled: true },
      { id: 'ui-settings-account', disabled: true },
    ]),
)

const profilePatch = join(home, 'profiles', 'oryh-web', 'cordis.patch.yml')
if (existsSync(profilePatch) && readFileSync(profilePatch, 'utf8').startsWith(written))
  writeFileSync(profilePatch, '[]\n')

const settingsPath = join(home, 'settings.yaml')
let settings
try {
  settings = YAML.parse(readFileSync(settingsPath, 'utf8'))
} catch {
  settings = undefined
}
if (settings && typeof settings === 'object') {
  const saved = ['llm-deepseek', 'llm-pi-ai', 'agent-default-model'].filter(key => key in settings)
  if (saved.length) {
    for (const key of saved) delete settings[key]
    writeFileSync(settingsPath, YAML.stringify(settings), { mode: 0o600 })
  }
}
console.log(
  `Model: ${model} (reasoning ${effort}) via ${env.DEEPSEEK_BASE_URL ? new URL(env.DEEPSEEK_BASE_URL).host : 'api.deepseek.com'}, configured by the deployment.`,
)
