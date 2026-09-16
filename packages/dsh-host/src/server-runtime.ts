import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServerOryhRuntime, ipcServerBinding, requestOwnerHostConfig, type IpcChannel } from '@oryh/ai-client-core'
import type { OryhServerRuntime } from './index.js'

/**
 * The business runtime of an owner Host the server's control process started.
 *
 * The control process forks this Host with an IPC channel; nothing else can write to it, so it is the
 * trusted source of who is signed in. The Host asks for its configuration once, then sends every ORYH
 * request back over the same channel, where the person's grant is.
 * @returns the runtime and this Host's capabilities.
 */
export async function serverRuntimeFromParent(): Promise<OryhServerRuntime> {
  // The marker keeps a Host that merely has some IPC channel (a test runner's worker) from speaking this protocol on it.
  if (typeof process.send !== 'function' || process.env.ORYH_OWNER_HOST !== '1') throw new Error('oryh-client-host: server mode must be started by the ORYH server control process')
  const channel = process as unknown as IpcChannel
  const config = await requestOwnerHostConfig(channel)
  const lifetime = new AbortController()
  process.once('disconnect', () => lifetime.abort())
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dataDirectory = join(home, 'oryh')
  const binding = ipcServerBinding(channel, { origin: config.origin, identity: config.identity, signal: lifetime.signal })
  const runtime = createServerOryhRuntime({
    binding,
    dataDirectory,
    agentsHome: process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
    storeSecret: Buffer.from(config.storeSecret, 'base64'),
  })
  return { runtime, dataDirectory, capabilities: config.capabilities }
}
