/** Ask the product-owned native bootstrap to switch the complete Harness home. */
import { request } from 'node:http'

export async function activateDesktopProfile(connectionId: string): Promise<boolean> {
  const socketPath = process.env.ORYH_DESKTOP_PROFILE_SOCKET
  if (!socketPath) return true
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, path: '/activate', method: 'POST' }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Account switch did not complete')
          resolve((JSON.parse(body) as { ready: boolean }).ready === true)
        } catch (error) {
          reject(error)
        }
      })
    })
    call.on('error', reject)
    call.end(JSON.stringify({ connectionId }))
  })
}
