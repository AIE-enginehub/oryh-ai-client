/** Test doubles for the Host plugin: a Cordis context that records registrations, and one enterprise connection. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { OryhClientController } from '@oryh/ai-client-core'
import { type ConnectionId, OryhClientError } from '@oryh/ai-client-foundation'
import type { PageId } from '@oryh/ai-client-pages'
import type { OryhLibrary, SharedEntry } from '@oryh/dsh-connection'
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
  /** Names the runtime does not have, for a test of a policy that names one. */
  const missing = new Set<string>()
  /** Names only a session's preset has: seen when asked as the agent sees them, not in the global list. */
  const presetOnly = new Set<string>()
  const guards: ((exec: unknown) => string | undefined)[] = []
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const plugins: unknown[] = []
  let section: string | (() => string) = ''
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
      // The preset's tools are not registered through this context; every name is taken to exist unless
      // a test says otherwise.
      get: (name: string, scope?: unknown) =>
        missing.has(name) || (presetOnly.has(name) && scope === undefined) ? undefined : (tools.get(name) ?? {}),
      guard: (guard: (exec: unknown) => string | undefined) => {
        guards.push(guard)
        return () => {
          guards.splice(guards.indexOf(guard), 1)
        }
      },
    },
    systemPrompt: {
      section: (s: { text: string | (() => string) }) => {
        section = s.text
      },
    },
    // As the runtime's: run at once, and hand back what takes it off again.
    effect: (fn: () => unknown) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on: (name: string, fn: (...args: never[]) => unknown) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
    },
    get: () => undefined,
    // As the runtime's, for services already there: a test gives them through `get` before it installs.
    inject: (names: string[], fn: (inner: Context) => unknown) => {
      if (names.every(name => (ctx as unknown as { get(name: string): unknown }).get(name) !== undefined)) fn(ctx)
    },
  } as unknown as Context
  return {
    ctx,
    agent,
    tools,
    missing,
    presetOnly,
    guards,
    listeners,
    plugins,
    /** The business section as the next assembly would read it. */
    prompt: () => (typeof section === 'function' ? section() : section),
    tool: (name: string) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`tool ${name} is not registered`)
      return tool
    },
    /** As the runtime dispatches a lifecycle event: each listener awaited in turn, in order. */
    emit: async (name: string, payload: unknown) => {
      for (const fn of listeners.get(name) ?? []) await (fn as unknown as (p: unknown) => unknown)(payload)
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

/**
 * One enterprise's shared library, as the deployment keeps it, for several stand-in Hosts at once.
 * @returns a factory: the library as one person's Host sees it.
 */
export function fakeLibrary() {
  const entries: (SharedEntry & { by: string })[] = []
  const listeners = new Set<(kind: SharedEntry['kind']) => void>()
  // Each change is later than the last, as the deployment's clock would have it.
  let changes = 0
  const tell = (kind: SharedEntry['kind']) => {
    for (const listener of [...listeners]) listener(kind)
  }
  return (user: string, name: string): OryhLibrary => {
    const seen = ({ by, ...entry }: SharedEntry & { by: string }): SharedEntry => ({ ...entry, mine: by === user })
    return {
      list: async kind => entries.filter(e => e.kind === kind).map(seen),
      get: async (kind, id) => {
        const entry = entries.find(e => e.kind === kind && e.id === id)
        return entry && seen(entry)
      },
      put: async item => {
        const old = entries.findIndex(e => e.kind === item.kind && e.id === item.id)
        if (old >= 0 && entries[old]!.by !== user)
          throw new OryhClientError('只有共享的人可以更新它。', 'request-failed')
        const updatedAt = new Date(Date.UTC(2026, 9, 12, 0, 0, ++changes)).toISOString()
        const entry = { ...item, author: name, mine: true, updatedAt, by: user }
        if (old >= 0) entries[old] = entry
        else entries.push(entry)
        tell(item.kind)
        return seen(entry)
      },
      remove: async (kind, id) => {
        const index = entries.findIndex(e => e.kind === kind && e.id === id && e.by === user)
        if (index < 0) return false
        entries.splice(index, 1)
        tell(kind)
        return true
      },
      onChanged: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }
}

/** Activation double: a distinct provider signal, startup-only forwarding, manager-owned teardown, caller delivery. */
export function fakeSubagents() {
  const providers = new Map<string, import('@deepseek-ai/dsh-subagent').SubagentProvider>()
  return {
    registerProvider(provider: import('@deepseek-ai/dsh-subagent').SubagentProvider) {
      providers.set(provider.name, provider)
      return () => {
        providers.delete(provider.name)
      }
    },
    startActivation: vi.fn(async (spec: import('@deepseek-ai/dsh-subagent').SubagentActivationSpec) => {
      const controller = new AbortController()
      const abort = () => controller.abort(spec.signal.reason)
      spec.signal.addEventListener('abort', abort, { once: true })
      let run: import('@deepseek-ai/dsh-subagent').SubagentRun
      try {
        spec.signal.throwIfAborted()
        const provider = providers.get(spec.provider)
        if (!provider?.start) throw new Error('no child sessions here')
        run = await provider.start({
          ...spec.request,
          cwd: spec.request.cwd ?? '/work',
          label: spec.label,
          signal: controller.signal,
        })
      } finally {
        spec.signal.removeEventListener('abort', abort)
      }
      let disposal: Promise<void> | undefined
      const dispose = () =>
        (disposal ??= (async () => {
          controller.abort()
          await run.dispose()
        })())
      const result = run.result.finally(() => dispose())
      void result.catch(() => {})
      return { childId: run.id, result, dispose }
    }),
  }
}
