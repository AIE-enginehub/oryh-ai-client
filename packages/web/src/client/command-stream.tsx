/** One Host command stream per bound session, shared by every business view. */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { CommandSnapshot } from '@oryh/dsh-host/types'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import { LocalRemoteError, useOryhRemote } from './remote.js'

/**
 * Where the linkage stands, so a disconnect is never shown as a refusal.
 *
 * `idle` means no session is bound in this subtree at all; `reconnecting` keeps the last
 * commands published while the carrier retries; `rejected` is terminal and publishes none.
 */
export type CommandStatus = 'idle' | 'connecting' | 'synced' | 'reconnecting' | 'rejected'

/** Published command state: the last full set the Host sent, plus where the linkage stands. */
export interface CommandState {
  /** Every command pending for the bound session. */
  readonly commands: CommandSnapshot
  /** Connection state, so transient loss and a final refusal read differently. */
  readonly status: CommandStatus
  /** Set once the linkage fails terminally, whether binding or streaming. */
  readonly error?: string
}

/** React-free subscription surface, so views never own a transport. */
export interface CommandStore {
  getSnapshot(): CommandState
  subscribe(listener: () => void): () => void
}

/** A store plus the lifecycle its owner drives. */
export interface CommandStreamHandle extends CommandStore {
  /** Begin consuming; repeated calls are inert. */
  start(): void
  /** Stop permanently and wait for the consumer to become quiescent. */
  dispose(): Promise<void>
}

const nothingBound: CommandState = { commands: {}, status: 'idle' }
const unbound: CommandStore = { getSnapshot: () => nothingBound, subscribe: () => () => {} }

/** A static store for a binding that failed terminally, so views can report it. */
function refused(message: string): CommandStore {
  const state: CommandState = { commands: {}, status: 'rejected', error: message }
  return { getSnapshot: () => state, subscribe: () => () => {} }
}

/** Unbound default: views outside a bound session simply see no commands. */
export const CommandsContext = createContext<CommandStore>(unbound)

/**
 * Read the session's pending commands.
 * @returns the latest published set, re-rendering the caller on every change.
 */
export function useCommands(): CommandState {
  const store = useContext(CommandsContext)
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/**
 * Re-read a view when the agent may have changed ORYH data (ADR-0010).
 *
 * The Host moves `serverChange` after a turn that ran a skill step through the shell, which is how a
 * timesheet submitted in Chat comes to read 已提交 in the business pane. A view on screen re-reads at
 * once; a hidden one remembers and re-reads when it is shown. The marker a view finds when it first
 * joins the stream is already covered by its own first load, so only later moves count — including
 * one that arrives in the baseline after a reconnect, since the view may have missed it.
 * @param active - whether the view is on screen.
 * @param refresh - re-reads what the view shows; the latest function passed is the one called.
 */
export function useServerRefresh(active: boolean, refresh: () => void): void {
  const { commands, status } = useCommands()
  const change = commands.serverChange?.id
  const seen = useRef<string | undefined>(undefined)
  const joined = useRef(false)
  const stale = useRef(false)
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    if (status !== 'synced') return
    if (!joined.current) { joined.current = true; seen.current = change; return }
    if (change === undefined || change === seen.current) return
    seen.current = change
    if (active) latest.current()
    else stale.current = true
  }, [change, status, active])
  useEffect(() => {
    if (active && stale.current) { stale.current = false; latest.current() }
  }, [active])
}

/**
 * Cancellable backoff for binding. A transport failure is worth asking again; the schedule is
 * finite so even a misclassified failure stops instead of retrying for the session's lifetime.
 */
const bindBackoffMs = [500, 1000, 2000, 4000, 8000] as const

/**
 * Bind the session to its enterprise home, then follow its commands for every view below.
 *
 * The bind has to land before the stream opens, because the Host refuses an unbound session.
 * Only transport failures are retried: a refusal the Host decided on will not change by asking
 * again, so it stops and publishes a terminal state instead of hiding behind a retry loop.
 * Leaving the session withdraws the binding.
 * @param props - the bound session, its connection, and the views that read commands.
 */
export function CommandStream({ sessionId, connectionId, children }: {
  sessionId: string | undefined
  connectionId: ConnectionId
  children: ReactNode
}): ReactNode {
  const api = useOryhRemote()
  const [store, setStore] = useState<CommandStreamHandle>()
  const [refusal, setRefusal] = useState<string>()
  useEffect(() => {
    if (sessionId === undefined) return
    const session = sessionId
    let live = true, bound = false, attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined, handle: CommandStreamHandle | undefined
    function bind(): void {
      void api.chatSelect({ sessionId: session, connectionId, homeOnly: true }).then(() => {
        if (!live) return
        bound = true
        setRefusal(undefined)
        handle = api.openCommands({ sessionId: session, connectionId })
        handle.start()
        setStore(handle)
      }).catch((error: unknown) => {
        if (!live) return
        const wait = error instanceof LocalRemoteError && error.business ? undefined : bindBackoffMs[attempt]
        if (wait === undefined) {
          setRefusal(error instanceof Error && error.message.length > 0 ? error.message : '无法绑定企业会话。')
          return
        }
        attempt++
        timer = setTimeout(bind, wait)
      })
    }
    bind()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
      setStore(undefined)
      setRefusal(undefined)
      void handle?.dispose()
      // Only withdraw a binding this instance actually established. Clearing is keyed by session
      // id alone, so a never-bound instance would be withdrawing whatever binding now holds it.
      if (bound) void api.chatHomeClear(session).catch(() => {})
    }
  }, [api, sessionId, connectionId])
  const value = store ?? (refusal === undefined ? unbound : refused(refusal))
  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>
}
