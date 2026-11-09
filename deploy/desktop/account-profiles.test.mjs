import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { accountKey, accountProfiles } from './account-profiles.mjs'
import { desktopProfilePatch } from './profile-patch.mjs'

function fixture(t, pins = true) {
  const data = mkdtempSync(join(tmpdir(), 'oryh-accounts-'))
  t.after(() => rmSync(data, { recursive: true, force: true }))
  const a = {
    id: 'a',
    origin: 'https://a.test',
    identity: { tenant: { id: 't' }, user: { id: 'u', employeeId: 'e' }, environmentId: 'env' },
  }
  const b = { ...a, id: 'b', origin: 'https://b.test' }
  mkdirSync(join(data, 'business', 'chat-bindings'), { recursive: true })
  mkdirSync(join(data, 'harness', 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(data, 'business', 'connections.json'), JSON.stringify({ connections: [a, b] }))
  writeFileSync(join(data, 'harness', 'profiles', 'desktop', 'cordis.patch.yml'), 'model-settings')
  mkdirSync(join(data, 'harness', 'sessions'))
  writeFileSync(join(data, 'harness', 'sessions', 'history'), 'account-a-history')
  if (pins)
    writeFileSync(
      join(data, 'business', 'chat-bindings', 'pin.json'),
      JSON.stringify({ scope: JSON.stringify([a.origin, 't', 'u', 'e']) }),
    )
  return { data, a, b }
}
test('server, tenant, environment, user and employee partition a Profile; new grant ids do not', () => {
  const a = {
    origin: 'https://a.test',
    identity: { tenant: { id: 't' }, user: { id: 'u', employeeId: 'e' }, environmentId: 'env' },
  }
  assert.equal(accountKey(a), accountKey({ ...a, id: 'reauthorized' }))
  for (const b of [
    { ...a, origin: 'https://b.test' },
    { ...a, identity: { ...a.identity, tenant: { id: 't2' } } },
    { ...a, identity: { ...a.identity, user: { id: 'u2', employeeId: 'e' } } },
    { ...a, identity: { ...a.identity, user: { id: 'u', employeeId: 'e2' } } },
    { ...a, identity: { ...a.identity, environmentId: 'other' } },
  ])
    assert.notEqual(accountKey(a), accountKey(b))
})
test('new server cannot see legacy history; returning owner restores exact history/workspace stores', t => {
  const { data } = fixture(t)
  const initial = accountProfiles(data)
  assert.equal(initial.current.key, 'signed-out')
  // Cancellation does not change the durable selection.
  initial.select('b')
  assert.equal(accountProfiles(data).current.key, 'signed-out')
  initial.select('a').commit()
  const first = accountProfiles(data)
  assert.equal(first.current.home, join(data, 'harness'))
  first.select('b').commit()
  const second = accountProfiles(data)
  assert.notEqual(second.current.home, first.current.home)
  assert.notEqual(second.current.workspace, first.current.workspace)
  assert.equal(readFileSync(join(second.current.profile, 'cordis.patch.yml'), 'utf8'), 'model-settings')
  mkdirSync(join(second.current.home, 'sessions'))
  writeFileSync(join(second.current.home, 'sessions', 'history'), 'account-b-history')
  second.select('a').commit()
  assert.equal(
    readFileSync(join(accountProfiles(data).current.home, 'sessions', 'history'), 'utf8'),
    'account-a-history',
  )
  accountProfiles(data).select('b').commit()
  assert.equal(
    readFileSync(join(accountProfiles(data).current.home, 'sessions', 'history'), 'utf8'),
    'account-b-history',
  )
})
test('unbound and mixed legacy history is retained without assigning it to the newest account', t => {
  const { data, a } = fixture(t, false)
  const profiles = accountProfiles(data)
  profiles.select('a').commit()
  assert.notEqual(accountProfiles(data).current.home, join(data, 'harness'))
  assert.equal(readFileSync(join(data, 'harness', 'sessions', 'history'), 'utf8'), 'account-a-history')
  assert.throws(() => profiles.select('../outside'))
  assert.equal(accountProfiles(data).current.key, accountKey(a))
})
test('desktop patch keeps model settings, shares API credential seam and changes only its generated workspace block', () => {
  const old = desktopProfilePatch('# custom\n[]\n', '/data/business')
  const next = desktopProfilePatch(
    old,
    '/data/business',
    '/data/harness/.credentials.yaml',
    '/data/accounts/b/workspace',
  )
  assert.ok(next.includes('# custom'))
  assert.equal((next.match(/- id: oryh-connection/g) || []).length, 1)
  assert.ok(next.includes('workspace: "/data/accounts/b/workspace"'))
  assert.ok(next.includes('path: "/data/harness/.credentials.yaml"'))
  const again = desktopProfilePatch(
    next,
    '/data/business',
    '/data/harness/.credentials.yaml',
    '/data/accounts/b/workspace',
  )
  assert.equal((again.match(/- id: credentials/g) || []).length, 1)
  assert.equal(again, next)
  assert.ok(
    desktopProfilePatch(next, '/test/business', '/test/credentials', '/test/workspace').includes(
      'path: "/test/credentials"',
    ),
  )
})
