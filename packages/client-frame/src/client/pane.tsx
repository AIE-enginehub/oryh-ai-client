/**
 * The business pane's side of the bridge to Chat: one binding per session, one stream of what the
 * agent asks, one sync of what the pane shows. Pages take part through the hooks here and never own
 * a transport of their own.
 */
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { PageId } from '@oryh/ai-client-pages'
import type { AnyPaneCommand, PaneAck, PaneContext, PaneFormProposal, PaneNavigation } from '@oryh/dsh-pane/types'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { BusinessView } from './layout-store.js'
import { nothingBound, type PaneStreamHandle, type PaneStreamState, type PaneStreamStore } from './pane-stream.js'
import { LocalRemoteError, useOryhRemote } from './remote.js'
import { publishUserViews } from './user-views.js'

/** The Chat session the business pane is bound to; undefined when no session is open. */
export const BusinessSessionContext = createContext<string | undefined>(undefined)
/** Opens a business view, as the menu does. */
export const BusinessNavigationContext = createContext<(page: BusinessView) => void>(() => {})

/** What the pane reports to the Host: the current page's context, and the commands it carried out. */
export interface PaneLocalState {
  readonly context?: PaneContext
  readonly acks: readonly PaneAck[]
}

/** The pane's own state, kept outside React so the sync loop can read it without re-rendering pages. */
export class PaneLocalStore {
  #state: PaneLocalState = { acks: [] }
  readonly #listeners = new Set<() => void>()
  getSnapshot(): PaneLocalState {
    return this.#state
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  private set(next: PaneLocalState): void {
    this.#state = next
    for (const listener of [...this.#listeners]) listener()
  }
  /** What the current page shows; unchanged content is not republished. */
  setContext(context: PaneContext | undefined): void {
    if (JSON.stringify(context) === JSON.stringify(this.#state.context)) return
    const { context: _previous, ...rest } = this.#state
    this.set(context === undefined ? rest : { ...rest, context })
  }
  /** Record that a command was carried out; it rides on the next sync. */
  ack(lane: string, id: string): void {
    if (this.#state.acks.some(a => a.id === id)) return
    this.set({ ...this.#state, acks: [...this.#state.acks, { lane, id }] })
  }
  /** Drop acknowledgements the Host has received. Silent: nothing new to sync follows from it. */
  sent(acks: readonly PaneAck[]): void {
    if (!acks.length) return
    this.#state = { ...this.#state, acks: this.#state.acks.filter(a => !acks.includes(a)) }
  }
}

interface PaneValue {
  stream: PaneStreamStore
  local: PaneLocalStore
}
const unbound: PaneStreamStore = { getSnapshot: () => nothingBound, subscribe: () => () => {} }
/** Unbound default: views outside a bound session see no commands and their reports go nowhere. */
export const PaneValueContext = createContext<PaneValue>({ stream: unbound, local: new PaneLocalStore() })

/** A static store for a binding that failed terminally, so views can report it. */
function refused(message: string): PaneStreamStore {
  const state: PaneStreamState = { commands: [], state: {}, status: 'rejected', error: message }
  return { getSnapshot: () => state, subscribe: () => () => {} }
}

/**
 * Cancellable backoff for binding. A transport failure is worth asking again; the schedule is
 * finite so even a misclassified failure stops instead of retrying for the session's lifetime.
 */
const bindBackoffMs = [500, 1000, 2000, 4000, 8000] as const
/** How long page changes are batched before one sync carries them all. */
const SYNC_DEBOUNCE_MS = 40

/**
 * Bind the session to its enterprise, follow the agent's commands, and report what the pane shows.
 *
 * The bind has to land before the stream opens, because the Host refuses an unbound session.
 * Only transport failures are retried: a refusal the Host decided on will not change by asking
 * again, so it stops and publishes a terminal state instead of hiding behind a retry loop.
 * Leaving the session withdraws the binding.
 * @param props - the bound session, its connection, the page showing, and the views below.
 */
export function PaneProvider({
  sessionId,
  connectionId,
  page,
  scope,
  children,
}: {
  sessionId: string | undefined
  connectionId: ConnectionId
  /** The page the Host checks permissions against; a person's own menu entry reports the list it narrows. */
  page: PageId
  /** Enterprise identity scope, for the menu mirror. */
  scope: string
  children: ReactNode
}): ReactNode {
  const api = useOryhRemote()
  const [local] = useState(() => new PaneLocalStore())
  const [instance] = useState(() => crypto.randomUUID())
  const [store, setStore] = useState<PaneStreamHandle>()
  const [refusal, setRefusal] = useState<string>()
  const [bound, setBound] = useState(false)
  useEffect(() => {
    if (sessionId === undefined) return
    const session = sessionId
    let live = true,
      attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined,
      handle: PaneStreamHandle | undefined,
      established = false
    function bind(): void {
      void api
        .paneBind({ sessionId: session, connectionId })
        .then(() => {
          if (!live) return
          established = true
          attempt = 0
          setRefusal(undefined)
          const opened = api.openPane({ sessionId: session, connectionId })
          handle = opened
          // A stream the Host refuses outright is usually a Host that no longer holds this binding —
          // it restarted. Binding again is the recovery, and without it the pane stays deaf until the
          // person reloads the page, which they have no reason to do.
          const watch = opened.subscribe(() => {
            if (!live || handle !== opened || opened.getSnapshot().status !== 'rejected') return
            const wait = bindBackoffMs[attempt]
            if (wait === undefined) return
            attempt++
            watch()
            handle = undefined
            void opened.dispose()
            setStore(undefined)
            setBound(false)
            timer = setTimeout(bind, wait)
          })
          opened.start()
          setStore(opened)
          setBound(true)
        })
        .catch((error: unknown) => {
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
      setBound(false)
      void handle?.dispose()
      // Only withdraw a binding this instance actually established. Clearing is keyed by session
      // id alone, so a never-bound instance would be withdrawing whatever binding now holds it.
      if (established) void api.paneUnbind(session).catch(() => {})
    }
  }, [api, sessionId, connectionId])

  // The sync loop: whatever changed — page, context or acknowledgements — the Host gets the whole
  // pane state once, under the next revision. A failed sync is retried with the latest state; the
  // Host ignores anything older than what it holds, so a late retry cannot roll it back.
  useLayoutEffect(() => {
    if (!bound || sessionId === undefined) return
    const session = sessionId
    let live = true,
      revision = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      inFlight = false,
      dirty = false
    async function send(): Promise<void> {
      if (!live || inFlight) {
        dirty = true
        return
      }
      inFlight = true
      dirty = false
      const snapshot = local.getSnapshot()
      revision++
      try {
        await api.paneSync({
          sessionId: session,
          connectionId,
          instance,
          revision,
          page,
          ...(snapshot.context ? { context: snapshot.context } : {}),
          ...(snapshot.acks.length ? { acks: [...snapshot.acks] } : {}),
        })
        local.sent(snapshot.acks)
      } catch {
        dirty = true
        if (live) timer = setTimeout(schedule, 500)
      } finally {
        inFlight = false
        if (live && dirty) schedule()
      }
    }
    function schedule(): void {
      if (!live) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void send(), SYNC_DEBOUNCE_MS)
    }
    const off = local.subscribe(schedule)
    schedule()
    return () => {
      live = false
      off()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, bound, sessionId, connectionId, instance, page, local])

  const stream = store ?? (refusal === undefined ? unbound : refused(refusal))
  const userViews = useSyncExternalStore(stream.subscribe, stream.getSnapshot).state.userViews
  useEffect(() => {
    publishUserViews(scope, userViews)
  }, [scope, userViews])
  return <PaneValueContext.Provider value={{ stream, local }}>{children}</PaneValueContext.Provider>
}

/**
 * Read the published pane: pending commands, Host state, and where the linkage stands.
 * @returns the latest frame, re-rendering the caller on every change.
 */
export function usePane(): PaneStreamState {
  const { stream } = useContext(PaneValueContext)
  return useSyncExternalStore(stream.subscribe, stream.getSnapshot)
}

/**
 * Report what the current page shows. The provider syncs it to the Host under the page it was
 * given; only the page on screen should call this.
 * @param context - the page's context, or undefined when nothing is on screen.
 */
export function usePageContext(context: PaneContext | undefined): void {
  const { local } = useContext(PaneValueContext)
  const json = JSON.stringify(context)
  useLayoutEffect(() => {
    local.setContext(context)
  }, [local, json])
}

/** Acknowledge a command by hand, for commands a person applies or dismisses later. */
export function usePaneAck(): (lane: string, id: string) => void {
  const { local } = useContext(PaneValueContext)
  return (lane, id) => local.ack(lane, id)
}

type PayloadOf<Lane extends AnyPaneCommand['lane']> = Extract<AnyPaneCommand, { lane: Lane }>['payload']

/**
 * Carry out the agent's commands on one lane, for one page.
 *
 * The handler runs once per command it accepts. Returning `false` declines it for now — the page is
 * not ready, or the command is not for it — and it is offered again when `deps` change or a new
 * frame arrives. Anything else acknowledges it, and the acknowledgement rides on the next sync.
 * @param lane - the lane to follow.
 * @param page - the page this component is; commands for other pages are ignored. `undefined` follows every page.
 * @param handler - carries the command out.
 * @param deps - values the handler reads; a change re-offers a declined command.
 */
export function useCommand<Lane extends AnyPaneCommand['lane']>(
  lane: Lane,
  page: PageId | undefined,
  handler: (payload: PayloadOf<Lane>, command: AnyPaneCommand) => boolean | undefined,
  deps: readonly unknown[] = [],
): void {
  const { local } = useContext(PaneValueContext)
  const { commands } = usePane()
  const command = commands.find(c => c.lane === lane && (page === undefined || c.page === undefined || c.page === page))
  const latest = useRef(handler)
  latest.current = handler
  const handled = useRef<string>()
  const id = command?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` are the handler's own reads.
  useEffect(() => {
    if (!command || id === undefined || handled.current === id || command.expiresAt < Date.now()) return
    const result = latest.current(command.payload as PayloadOf<Lane>, command)
    if (result === false) return
    handled.current = id
    local.ack(lane, id)
  }, [id, local, lane, ...deps])
}

/**
 * Re-read a view when the agent may have changed ORYH data (ADR-0010).
 *
 * The Host moves `serverChange` after a turn that wrote through an ORYH tool or the shell, which is
 * how a timesheet submitted in Chat comes to read 已提交 in the business pane. A view on screen
 * re-reads at once; a hidden one remembers and re-reads when it is shown. The marker a view finds
 * when it first joins the stream is already covered by its own first load, so only later moves count
 * — including one that arrives in the baseline after a reconnect, since the view may have missed it.
 * @param active - whether the view is on screen.
 * @param refresh - re-reads what the view shows; the latest function passed is the one called.
 */
export function useServerRefresh(active: boolean, refresh: () => void): void {
  const { state, status } = usePane()
  const change = state.serverChange?.id
  const seen = useRef<string | undefined>(undefined)
  const joined = useRef(false)
  const stale = useRef(false)
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    if (status !== 'synced') return
    if (!joined.current) {
      joined.current = true
      seen.current = change
      return
    }
    if (change === undefined || change === seen.current) return
    seen.current = change
    if (active) latest.current()
    else stale.current = true
  }, [change, status, active])
  useEffect(() => {
    if (active && stale.current) {
      stale.current = false
      latest.current()
    }
  }, [active])
}

export type { PaneFormProposal, PaneNavigation }
