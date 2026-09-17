// The model is a deployment decision, not something each person configures.
//
// The deployment supplies the endpoint, key and model through the container environment
// (compose.yaml, fed from `.env`). The key stays in the inherited environment, which Harness reads
// first and treats as read-only, and which it scrubs from the shell the agent runs. This script runs
// at every start, before DSH boots, and makes that choice authoritative:
//   - the profile patch pins the default model and removes the Models settings page and the
//     per-session model picker, so there is nothing to configure in the browser;
//   - any model section a person saved earlier is removed from the user settings layer, which would
//     otherwise outrank the deployment.
import { readFileSync, writeFileSync } from 'node:fs'
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
  join(env.DSH_HARNESS_ROOT ?? '/opt/deepseek-harness', 'packages/settings/settings-file/package.json'),
)('yaml')

const patch = [
  { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
  // The endpoint comes from DEEPSEEK_BASE_URL in the environment; only the deployment's effort is set here.
  { id: 'llm-deepseek', config: { reasoningEffort: effort } },
  { id: 'ui-settings-models', disabled: true },
  { id: 'ui-model-selection', disabled: true },
]
writeFileSync(
  join(home, 'profiles', 'oryh-web', 'cordis.patch.yml'),
  '# Written by deploy/local/model-config.mjs at every container start; edits here are replaced.\n' +
    YAML.stringify(patch),
)

const settingsPath = join(home, 'settings.yaml')
let settings
try {
  settings = YAML.parse(readFileSync(settingsPath, 'utf8'))
} catch {
  settings = undefined
}
if (settings && typeof settings === 'object') {
  const saved = ['llm-deepseek', 'agent-default-model'].filter(key => key in settings)
  if (saved.length) {
    for (const key of saved) delete settings[key]
    writeFileSync(settingsPath, YAML.stringify(settings), { mode: 0o600 })
  }
}
console.log(
  `Model: ${model} (reasoning ${effort}) via ${env.DEEPSEEK_BASE_URL ? new URL(env.DEEPSEEK_BASE_URL).host : 'api.deepseek.com'}, configured by the deployment.`,
)
