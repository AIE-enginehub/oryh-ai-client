/**
 * A page's side of the bridge to Chat: what the agent asks of it, and what it reports back.
 *
 * The binding, the stream and the sync are the frame plugin's, kept in a service outside React. A page
 * reaches them through what the frame's slot hands it — hooks the renderer makes over the service's
 * sources, and a few callbacks — and passes that on to its own components as a prop. The hooks here take
 * it as their first argument; none of them owns a transport, and none reads a React context.
 */

import type { PageId } from '@oryh/ai-client-pages'
import type {
  AnyPaneCommand,
  PaneAck,
  PaneContext,
  PaneFormProposal,
  PaneNavigation,
  PaneState,
} from '@oryh/dsh-pane/types'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

/** A page a person can be on: a built-in one, or one of their own menu entries. */
export type BusinessView = Exclude<PageId, 'collection'> | `view:${string}`

/**
 * Where the linkage stands, so a disconnect is never shown as a refusal.
 *
 * `idle` means no session is bound at all; `reconnecting` keeps the last frame published while the
 * carrier retries; `rejected` is terminal and publishes none.
 */
export type PaneStatus = 'idle' | 'connecting' | 'synced' | 'reconnecting' | 'rejected'

/** Published pane state: the last full frame the Host sent, plus where the linkage stands. */
export interface PaneStreamState {
  /** Every command pending for the bound session. */
  readonly commands: readonly AnyPaneCommand[]
  /** Facts the Host publishes beside the commands. */
  readonly state: PaneState
  /** Connection state, so transient loss and a final refusal read differently. */
  readonly status: PaneStatus
  /** Set once the linkage fails terminally, whether binding or streaming. */
  readonly error?: string
}

export const nothingBound: PaneStreamState = { commands: [], state: {}, status: 'idle' }

/** What the pane reports to the Host: the current page's context, and the commands it carried out. */
export interface PaneLocalState {
  readonly context?: PaneContext
  readonly acks: readonly PaneAck[]
}

/** The pane's own state, kept outside React so the sync loop can read it without re-rendering pages. */
export class PaneLocalStore {
  #state: PaneLocalState = { acks: [] }
  readonly #listeners = new Set<() => void>()
  getSnapshot = (): PaneLocalState => this.#state
  subscribe = (listener: () => void): (() => void) => {
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
  setContext = (context: PaneContext | undefined): void => {
    if (JSON.stringify(context) === JSON.stringify(this.#state.context)) return
    const { context: _previous, ...rest } = this.#state
    this.set(context === undefined ? rest : { ...rest, context })
  }
  /** Record that a command was carried out; it rides on the next sync. */
  ack = (lane: string, id: string): void => {
    if (this.#state.acks.some(a => a.id === id)) return
    this.set({ ...this.#state, acks: [...this.#state.acks, { lane, id }] })
  }
  /** Drop acknowledgements the Host has received. Silent: nothing new to sync follows from it. */
  sent(acks: readonly PaneAck[]): void {
    if (!acks.length) return
    this.#state = { ...this.#state, acks: this.#state.acks.filter(a => !acks.includes(a)) }
  }
}

/** What a page may read and write of the pane's own state at a point in time. */
export type PaneLocal = Pick<PaneLocalStore, 'getSnapshot' | 'setContext' | 'ack'>

/** A hook the renderer makes over one source: the caller says what it reads of it. */
export type SelectHook<T> = <S>(selector: (value: T) => S, equal?: (a: S, b: S) => boolean) => S

/** The pane as a page's components are handed it: two hooks the renderer made, and the pane's own state. */
export interface PaneFace {
  /** The published pane: pending commands, Host state, and where the linkage stands. */
  usePane: SelectHook<PaneStreamState>
  /** What the pane last reported of itself. */
  usePaneLocal: SelectHook<PaneLocalState>
  local: PaneLocal
}

const whole = <T,>(value: T): T => value

/**
 * Read the published pane: pending commands, Host state, and where the linkage stands.
 * @param face - what the page's slot handed it.
 * @returns the latest frame, re-rendering the caller on every change.
 */
export function usePane(face: PaneFace): PaneStreamState {
  return face.usePane(whole)
}

/**
 * Report what the current page shows. The frame syncs it to the Host under the page on screen; only
 * that page should call this.
 * @param face - what the page's slot handed it.
 * @param context - the page's context, or undefined when nothing is on screen.
 */
export function usePageContext(face: PaneFace, context: PaneContext | undefined): void {
  const { local } = face
  const json = JSON.stringify(context)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialised context is the dependency.
  useLayoutEffect(() => {
    local.setContext(context)
  }, [local, json])
}

type PayloadOf<Lane extends AnyPaneCommand['lane']> = Extract<AnyPaneCommand, { lane: Lane }>['payload']

/**
 * Carry out the agent's commands on one lane, for one page.
 *
 * The handler runs once per command it accepts. Returning `false` declines it for now — the page is
 * not ready, or the command is not for it — and it is offered again when `deps` change or a new
 * frame arrives. Anything else acknowledges it, and the acknowledgement rides on the next sync.
 * @param face - what the page's slot handed it.
 * @param lane - the lane to follow.
 * @param page - the page this component is; commands for other pages are ignored. `undefined` follows every page.
 * @param handler - carries the command out.
 * @param deps - values the handler reads; a change re-offers a declined command.
 */
export function useCommand<Lane extends AnyPaneCommand['lane']>(
  face: PaneFace,
  lane: Lane,
  page: PageId | undefined,
  handler: (payload: PayloadOf<Lane>, command: AnyPaneCommand) => boolean | undefined,
  deps: readonly unknown[] = [],
): void {
  const { local } = face
  const { commands } = usePane(face)
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
 * how something submitted in Chat comes to read 已提交 in the business pane. A view on screen
 * re-reads at once; a hidden one remembers and re-reads when it is shown. The marker a view finds
 * when it first joins the stream is already covered by its own first load, so only later moves count
 * — including one that arrives in the baseline after a reconnect, since the view may have missed it.
 * @param face - what the page's slot handed it.
 * @param active - whether the view is on screen.
 * @param refresh - re-reads what the view shows; the latest function passed is the one called.
 */
export function useServerRefresh(face: PaneFace, active: boolean, refresh: () => void): void {
  const { state, status } = usePane(face)
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

const NO_RECORDS: ReadonlySet<string> = new Set()

/**
 * The records of a collection the agent's last writing turn named, for a page to point out.
 *
 * A list re-reads when Chat has written, and then looks the same as before to someone who was not
 * watching the one row that changed. The Host names the records the turn's calls wrote; a list showing
 * one marks it and brings it into view, so what Chat just did can be found on the page.
 * @param face - what the page's slot handed it.
 * @param collection - the collection the page shows, as its path names it.
 * @param type - the collection's object type as the console writes it, where a page knows rows by that.
 * @returns the ids, until the next turn that writes; empty when the turn named none here.
 */
export function useWrittenRecords(face: PaneFace, collection: string, type?: string): ReadonlySet<string> {
  const { state } = usePane(face)
  const records = state.serverChange?.records
  return useMemo(() => {
    const ids = (records ?? [])
      .filter(r => r.collection === collection || (type !== undefined && objectTypeOf(r.collection) === type))
      .map(r => r.id)
    return ids.length ? new Set(ids) : NO_RECORDS
  }, [records, collection, type])
}

/** A collection's object type as ORYH's console writes it: `sales-orders` is `sales_order`. */
function objectTypeOf(collection: string): string {
  return collection.replace(/ies$/, 'y').replace(/s$/, '').replaceAll('-', '_')
}

export type { PaneFormProposal, PaneNavigation }
