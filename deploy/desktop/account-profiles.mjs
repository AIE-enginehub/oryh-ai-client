/** Desktop account roots. The official Harness owns everything inside each home. */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
export function accountKey(connection) {
  const { tenant, user } = connection.identity
  return digest(
    JSON.stringify([
      new URL(connection.origin).origin,
      tenant.id,
      connection.identity.environmentId ?? null,
      user.id,
      user.employeeId ?? null,
    ]),
  )
}
function read(file, fallback) {
  if (!existsSync(file)) return fallback
  return JSON.parse(readFileSync(file, 'utf8'))
}
function write(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

export function accountProfiles(data) {
  const legacyHome = join(data, 'harness')
  const directory = join(data, 'accounts')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stateFile = join(directory, 'selection.json')
  const connections = () => read(join(data, 'business', 'connections.json'), { connections: [] }).connections
  let state = read(stateFile, null)
  if (!state) {
    // A binding is durable proof of a conversation's owner. Never infer it from the most recent login.
    const pins = join(data, 'business', 'chat-bindings')
    const scopes = existsSync(pins)
      ? [
          ...new Set(
            readdirSync(pins)
              .filter(file => file.endsWith('.json'))
              .map(file => read(join(pins, file), {}).scope)
              .filter(Boolean),
          ),
        ]
      : []
    const rows = connections()
    const owners =
      scopes.length === 1
        ? rows.filter(row => {
            const { tenant, user } = row.identity
            return JSON.stringify([row.origin, tenant.id, user.id, user.employeeId ?? null]) === scopes[0]
          })
        : []
    const owner = new Set(owners.map(accountKey)).size === 1 ? owners[0] : undefined
    // Ambiguous/unbound legacy history stays on disk, outside every new account's home.
    state = { version: 1, legacyOwner: owner ? accountKey(owner) : null, selected: null }
    write(stateFile, state)
  }
  function prepare(connection) {
    const key = connection ? accountKey(connection) : 'signed-out'
    const root = join(directory, key)
    const home = key === state.legacyOwner ? legacyHome : join(root, 'harness')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    mkdirSync(join(root, 'workspace'), { recursive: true, mode: 0o700 })
    const profile = join(home, 'profiles', 'desktop')
    const previous = join(legacyHome, 'profiles', 'desktop')
    // Copy profile definitions/model settings only, never sessions, workspaces or derived stores.
    if (!existsSync(profile) && existsSync(previous)) {
      mkdirSync(profile, { recursive: true, mode: 0o700 })
      for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
        if (existsSync(join(previous, file))) cpSync(join(previous, file), join(profile, file))
      }
    }
    return { key, root, home, profile, workspace: join(root, 'workspace'), connectionId: connection?.id }
  }
  const selected = connections().find(row => row.id === state.selected)
  const current = prepare(selected)
  return {
    current,
    prepare,
    select(id) {
      const connection = connections().find(row => row.id === id)
      if (!connection) throw new Error('The selected ORYH connection is unavailable.')
      return {
        target: prepare(connection),
        commit() {
          state = { ...state, selected: id }
          write(stateFile, state)
        },
      }
    },
  }
}
