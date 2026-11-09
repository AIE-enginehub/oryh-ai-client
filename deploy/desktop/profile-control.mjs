/** Private native-shell control; never exposed to a browser or a network interface. */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function profileControl(profiles, switchProfile) {
  const privateDirectory = mkdtempSync(join(tmpdir(), 'oryh-profile-'))
  chmodSync(privateDirectory, 0o700)
  const socket = join(privateDirectory, 'control.sock')
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/activate') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 1024) throw new Error('Invalid account selection')
      }
      const { connectionId } = JSON.parse(body)
      if (typeof connectionId !== 'string') throw new Error('Invalid account selection')
      const selection = profiles.select(connectionId)
      if (selection.target.key === profiles.current.key) {
        selection.commit()
        response.end(JSON.stringify({ ready: true }))
      } else {
        // The shell confirms active work, commits only on approval, then closes the old Host fully.
        await switchProfile(selection.commit)
        response.end(JSON.stringify({ ready: false }))
      }
    } catch {
      response.writeHead(409).end(JSON.stringify({ error: 'Account switch did not complete' }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  chmodSync(socket, 0o600)
  process.once('exit', () => rmSync(privateDirectory, { force: true, recursive: true }))
  return { socket, close: () => server.close() }
}
