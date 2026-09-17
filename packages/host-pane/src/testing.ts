/** Test doubles for the Host plugin: a Cordis context that records registrations, and one enterprise connection. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { OryhClientController } from '@oryh/ai-client-core'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { PageId } from '@oryh/ai-client-pages'
import { vi } from 'vitest'
import type { PaneService } from './service.js'
import type { PaneContext } from './types.js'

export const connectionId = 'c' as ConnectionId

/** One agent as the runtime publishes it, with the fields the pane and the review read. */
export function fakeAgent(id = 's') {
  const agent = {
    id,
    status: 'idle' as string,
    session: {
      header: { isSeeded: false, parentSession: undefined as string | undefined, cwd: undefined as string | undefined },
    },
    inbox: { nextTurn: [] as { id: string }[] },
    followup: (message: { id: string }) => {
      agent.inbox.nextTurn.push({ id: String(message.id) })
    },
    ctx: {} as unknown,
  }
  return agent
}

/** A verified enterprise connection, mutable so a test can change the identity under a session. */
export function fakeConnection(
  permissions: string[] = [
    'master_data.manage',
    'expense.submit_own',
    'timesheet.submit_own',
    'approval.record',
    'order.submit_own',
    'inventory.manage',
  ],
) {
  return {
    id: connectionId,
    origin: 'https://oryh.example',
    identity: {
      permissions,
      tenant: { id: 'tenant', name: '晶诚' },
      user: { id: 'user', email: 'hua@example.invalid', employeeId: 'employee' as string | null },
    },
  }
}

/**
 * A context that records what a plugin registers: tools by name, listeners by event, the prompt
 * section, services by key, and runs effects at once so per-agent policies really apply. Plugins a
 * plugin under test loads (`ctx.plugin`) are recorded, not run: a Remote needs the Typert runtime.
 */
export function fakeContext(agent = fakeAgent()) {
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<string> }>()
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const plugins: unknown[] = []
  let prompt = ''
  const ctx = {
    provide: (key: string, value: unknown) => {
      Object.assign(ctx, { [key]: value })
    },
    plugin: (plugin: unknown) => {
      plugins.push(plugin)
    },
    agents: { get: (id: string) => (id === agent.id ? agent : undefined), list: () => [] },
    tools: {
      register: (tool: { name: string }) => {
        tools.set(tool.name, tool as never)
        return () => {
          tools.delete(tool.name)
        }
      },
    },
    systemPrompt: {
      section: (s: { text: string }) => {
        prompt = s.text
      },
    },
    effect: (fn: () => unknown) => {
      fn()
    },
    on: (name: string, fn: (...args: never[]) => unknown) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
    },
    get: () => undefined,
  } as unknown as Context
  return {
    ctx,
    agent,
    tools,
    listeners,
    plugins,
    prompt: () => prompt,
    tool: (name: string) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`tool ${name} is not registered`)
      return tool
    },
    emit: (name: string, payload: unknown) => {
      for (const fn of listeners.get(name) ?? []) (fn as unknown as (p: unknown) => void)(payload)
    },
  }
}

/** A controller over one connection, as the pane and the tools see it. */
export function fakeController(connection = fakeConnection(), connections = 1) {
  return {
    connection,
    controller: {
      verifyConnection: async () => connection,
      listConnections: async () => [connection, { ...connection, id: 'c2' }].slice(0, connections),
    } as unknown as OryhClientController,
  }
}

/** A private directory for the session pins, removed by `close`. */
export async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'oryh-chat-'))
  return { directory, close: () => rm(directory, { recursive: true, force: true }) }
}

/** A page instance that syncs to the pane with a monotonic revision, acknowledging commands as asked. */
export function paneSyncer(pane: PaneService, sessionId = 's', instance = 'i') {
  let revision = 0
  return {
    get revision() {
      return revision
    },
    sync(page: PageId, context?: PaneContext, acks: string[] = []) {
      revision++
      pane.sync({
        sessionId,
        connectionId,
        instance,
        revision,
        page,
        ...(context ? { context } : {}),
        acks: acks.map(id => ({ lane: 'navigation', id })),
      })
      return revision
    },
    /** Acknowledge the pending command on a lane, with the context the page then shows. */
    ack(lane: 'navigation' | 'form', page: PageId, context?: PaneContext) {
      const command = pane.queue.peek(sessionId, lane)
      if (!command) throw new Error(`no ${lane} command pending`)
      revision++
      pane.sync({
        sessionId,
        connectionId,
        instance,
        revision,
        page,
        ...(context ? { context } : {}),
        acks: [{ lane, id: command.id }],
      })
      return command
    },
  }
}

/** Drive timers until `ready`, so a command is observed rather than guessed at. */
export async function until(ready: () => boolean, ticks = 500) {
  for (let tick = 0; tick < ticks && !ready(); tick++)
    await new Promise(resolve => {
      setTimeout(resolve, 1)
    })
  if (!ready()) throw new Error('the Host never reached the expected state')
}

export const pending = (pane: PaneService, sessionId = 's', lane: 'navigation' | 'form' = 'navigation') =>
  pane.queue.peek(sessionId, lane)

export { vi }
