// ORYH sign-in in front of the loopback-only DSH web server.
//
// DSH authenticates a browser with a one-time launch link printed to its log. That is right for a
// developer on the same machine and wrong for anyone opening a container's address. This gateway
// replaces the link with ORYH's own OAuth 2.1 sign-in (authorization code + PKCE): the person signs
// in to ORYH, approves this client, and lands in the workbench. The same sign-in is handed to the
// client as its enterprise connection, so nobody authorizes twice.
//
// It does not weaken DSH: the gateway obtains DSH's own session cookie with the launch token it
// alone reads from DSH's output, and every other request is passed through untouched, so DSH still
// checks Host, Origin and that cookie. The first person to sign in owns this single-user container;
// a different ORYH account is refused rather than handed their sessions.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname } from 'node:path'

const env = process.env
const ORYH = new URL(required('ORYH_SERVER_ORIGIN')).origin
const PUBLIC_HOSTS = (env.ORYH_PUBLIC_HOSTS ?? '127.0.0.1:4180,localhost:4180')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean)
// Kept short on purpose: ORYH stores the consent request's parameters joined with `|` in a
// varchar(128) column, and a longer request fails there with a 500 after the person signs in.
const CLIENT_ID = env.ORYH_OAUTH_CLIENT_ID ?? 'https://oryh.ai'
const CONSENT_LIMIT = 128
const LISTEN_PORT = Number(env.GATEWAY_PORT ?? 4173)
const DSH_PORT = Number(env.DSH_PORT ?? 4174)
const HANDOFF = required('ORYH_CREDENTIAL_HANDOFF')
const OWNER = required('ORYH_CONTAINER_OWNER')
const STATE_COOKIE = 'oryh-login'
const LOGIN_TTL_MS = 10 * 60 * 1000

function log(message) {
  console.log(`login gateway: ${message}`)
}

function required(name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

// --- DSH child: its launch token is read here and never printed ---------------------------------

const separator = process.argv.indexOf('--')
const [command, ...args] = separator === -1 ? [] : process.argv.slice(separator + 1)
if (!command) throw new Error('usage: login-gateway.mjs -- <dsh command...>')

let launchToken
let resolveToken
const tokenReady = new Promise(resolve => {
  resolveToken = resolve
})
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
for (const [stream, sink] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) sink.write(redact(line) + '\n')
  })
}
function redact(line) {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(line)
  if (!match) return line
  if (!launchToken) {
    launchToken = match[1]
    resolveToken()
  }
  return `ORYH AI Client ready: open ${PUBLIC_HOSTS.map(host => `http://${host}/`).join(' or ')} and sign in with ORYH.`
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))

// --- HTTP ----------------------------------------------------------------------------------------

const pending = new Map()
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')
  const route =
    url.pathname === '/oryh/health'
      ? health
      : url.pathname === '/oryh/login'
        ? login
        : url.pathname === '/oryh/callback'
          ? callback
          : req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('token')
            ? index
            : proxy
  Promise.resolve(route(req, res, url)).catch(error => {
    console.error('login gateway:', error instanceof Error ? error.message : error)
    if (!res.headersSent) page(res, 502, '暂时无法登录', '登录服务出错，请稍后重试。', true)
    else res.destroy()
  })
})
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(DSH_PORT, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
    upstream.write(raw + '\r\n')
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})
server.listen(LISTEN_PORT, '0.0.0.0')

/** Everything DSH serves, passed through as is. */
function proxy(req, res) {
  const upstream = http.request(
    { host: '127.0.0.1', port: DSH_PORT, method: req.method, path: req.url, headers: req.headers },
    answer => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) page(res, 502, '客户端正在启动', '请几秒后刷新页面。', false)
    else res.destroy()
  })
  req.pipe(upstream)
}

/** The workbench itself, or ORYH sign-in when DSH does not recognise this browser. */
function index(req, res) {
  const upstream = http.request(
    { host: '127.0.0.1', port: DSH_PORT, method: req.method, path: req.url, headers: req.headers },
    answer => {
      if (answer.statusCode === 401) {
        answer.resume()
        log('index: not signed in to DSH, starting ORYH sign-in')
        res.writeHead(303, { location: '/oryh/login', 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    },
  )
  upstream.on('error', () => page(res, 502, '客户端正在启动', '请几秒后刷新页面。', false))
  upstream.end()
}

function health(_req, res) {
  const probe = http.request({ host: '127.0.0.1', port: DSH_PORT, method: 'HEAD', path: '/' }, answer => {
    answer.resume()
    res.writeHead(launchToken && [200, 401].includes(answer.statusCode) ? 200 : 503).end()
  })
  probe.on('error', () => res.writeHead(503).end())
  probe.end()
}

function login(req, res) {
  const host = publicHost(req)
  if (!host)
    return page(res, 400, '无法登录', '请通过 ' + PUBLIC_HOSTS.map(h => `http://${h}/`).join(' 或 ') + ' 访问。', false)
  const now = Date.now()
  for (const [key, entry] of pending) if (entry.expires < now) pending.delete(key)
  // 96 bits: the state only has to be unguessable for ten minutes, and it is also bound to a cookie.
  const state = randomBytes(12).toString('base64url')
  const verifier = token()
  const redirectUri = `http://${host}/oryh/callback`
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const consent = ['code', CLIENT_ID, redirectUri, challenge, 'S256', state, '', ''].join('|')
  if (consent.length > CONSENT_LIMIT) {
    return page(
      res,
      500,
      '无法登录',
      `登录参数超出 ORYH 的长度限制（${consent.length} > ${CONSENT_LIMIT}），请缩短 ORYH_OAUTH_CLIENT_ID 或访问地址。`,
      false,
    )
  }
  pending.set(state, { verifier, redirectUri, expires: now + LOGIN_TTL_MS })
  log(`login: redirecting to ORYH authorize (callback ${redirectUri})`)
  const authorize = new URL('/oauth/authorize', ORYH)
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }))
    authorize.searchParams.set(key, value)
  res.writeHead(303, {
    location: authorize.href,
    'cache-control': 'no-store',
    'set-cookie': `${STATE_COOKIE}=${state}; Path=/oryh; Max-Age=${LOGIN_TTL_MS / 1000}; HttpOnly; SameSite=Lax`,
  })
  res.end()
}

async function callback(req, res, url) {
  const state = url.searchParams.get('state') ?? ''
  log(`callback: received (${url.searchParams.has('code') ? 'code' : (url.searchParams.get('error') ?? 'no code')})`)
  const entry = pending.get(state)
  pending.delete(state)
  if (
    !entry ||
    entry.expires < Date.now() ||
    cookie(req, STATE_COOKIE) !== state ||
    `http://${publicHost(req)}/oryh/callback` !== entry.redirectUri
  ) {
    log(`callback: rejected (known state ${Boolean(entry)}, state cookie ${cookie(req, STATE_COOKIE) === state})`)
    return page(res, 400, '登录已过期', '这次登录请求已失效，请重新登录。', true)
  }
  if (url.searchParams.get('error')) {
    return page(
      res,
      403,
      '没有完成授权',
      url.searchParams.get('error') === 'access_denied'
        ? '你拒绝了授权。需要使用客户端时请重新登录。'
        : '授权没有完成，请重新登录。',
      true,
    )
  }
  const tokens = await oryh('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: url.searchParams.get('code') ?? '',
      code_verifier: entry.verifier,
      client_id: CLIENT_ID,
      redirect_uri: entry.redirectUri,
    }),
  })
  if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string')
    throw new Error('ORYH returned no token')
  const me = (await oryh('/api/v1/auth/me', { headers: { 'X-API-Key': tokens.access_token } })).data ?? {}
  const principal = { origin: ORYH, tenantId: String(me.tenant_id ?? ''), userId: String(me.id ?? '') }
  if (!principal.tenantId || !principal.userId) throw new Error('ORYH returned no identity')
  const owner = readOwner()
  if (
    owner &&
    (owner.origin !== principal.origin || owner.tenantId !== principal.tenantId || owner.userId !== principal.userId)
  ) {
    await fetch(new URL('/oauth/revoke', ORYH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token }),
      redirect: 'error',
    }).catch(() => {})
    return page(
      res,
      403,
      '这个客户端属于其他账号',
      `这是 ${escape(owner.email ?? '另一个 ORYH 账号')} 的单用户客户端，请用该账号登录。`,
      true,
    )
  }
  if (!owner) writePrivate(OWNER, { ...principal, email: me.email ?? null })
  writePrivate(HANDOFF, {
    origin: ORYH,
    accessKey: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:
      typeof tokens.expires_in === 'number' ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
  })
  log('callback: ORYH identity verified, credential handed to the client')
  const session = await dshSession(publicHost(req))
  log('callback: DSH session issued, returning to the workbench')
  res.writeHead(303, {
    location: '/',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': [...session, `${STATE_COOKIE}=; Path=/oryh; Max-Age=0; HttpOnly; SameSite=Lax`],
  })
  res.end()
}

/** Exchange DSH's launch token for its session cookie, bound to the browser's own Host. */
async function dshSession(host) {
  await tokenReady
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: DSH_PORT, method: 'GET', path: `/?token=${launchToken}`, headers: { host } },
      answer => {
        answer.resume()
        const cookies = answer.headers['set-cookie']
        if (answer.statusCode === 303 && cookies?.length) resolve(cookies)
        else reject(new Error(`DSH did not issue a session (${answer.statusCode})`))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

async function oryh(path, init) {
  const response = await fetch(new URL(path, ORYH), { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`ORYH ${path} answered ${response.status}`)
  return body
}

function publicHost(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  return PUBLIC_HOSTS.includes(host) ? host : undefined
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

function readOwner() {
  try {
    return JSON.parse(readFileSync(OWNER, 'utf8'))
  } catch {
    return undefined
  }
}

function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

function token() {
  return randomBytes(32).toString('base64url')
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

function page(res, status, title, message, retry) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ORYH AI Client</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f5f5;color:#222">
<main style="background:#fff;padding:32px 40px;border-radius:8px;box-shadow:0 1px 4px #0002;max-width:420px">
<h1 style="font-size:20px;margin:0 0 12px">${title}</h1><p style="line-height:1.6">${message}</p>
${retry ? '<p><a href="/oryh/login" style="display:inline-block;background:#0f6cbd;color:#fff;padding:8px 20px;border-radius:4px;text-decoration:none">使用 ORYH 登录</a></p>' : ''}
</main></body></html>`)
}
