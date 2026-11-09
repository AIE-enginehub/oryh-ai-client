import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { profileControl } from './profile-control.mjs'

function activate(socketPath, connectionId) {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, path: '/activate', method: 'POST' }, response => {
      let body = ''
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }))
    })
    call.on('error', reject)
    call.end(JSON.stringify({ connectionId }))
  })
}
test('native private control only resumes the matching Profile, no cross-account business activation', async t => {
  const committed = []
  const profiles = {
    current: { key: 'a' },
    select(id) {
      if (!['a', 'b'].includes(id)) throw new Error('unknown')
      return { target: { key: id }, commit: () => committed.push(id) }
    },
  }
  const control = await profileControl(profiles, async commit => {
    commit()
  })
  t.after(() => control.close())
  assert.deepEqual(await activate(control.socket, 'a'), { status: 200, body: { ready: true } })
  assert.deepEqual(await activate(control.socket, 'b'), { status: 200, body: { ready: false } })
  assert.equal((await activate(control.socket, '../unknown')).status, 409)
  assert.deepEqual(committed, ['a', 'b'])
})
