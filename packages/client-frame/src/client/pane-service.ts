/**
 * The business pane's side of the bridge to Chat, as a service: one binding per session, one stream of
 * what the agent asks, one sync of what the pane shows.
 *
 * It lives in the plugin, outside React. The workbench only says what is on show — which connection,
 * which session, which page — and the pages read the two sources here through hooks the renderer makes
 * for them. A binding therefore lasts as long as the plugin wants it to, not as long as a component
 * happens to stay mounted, and no component holds a transport.
 */

import type { ConnectionId } from '@oryh/ai-client-foundation'
import {
  LocalRemoteError,
  nothingBound,
  type OryhText,
  PaneLocalStore,
  type PaneRemote,
  type PaneStreamHandle,
  type PaneStreamState,
  type PaneStreamStore,
} from '@oryh/ai-client-kit'
import type { PageId } from '@oryh/ai-client-pages'
import { enterAgainIfLost } from './permission-check.js'
import type { MenuMirror } from './user-views.js'

/**
 * Cancellable backoff for binding. A transport failure is worth asking again; the schedule is
 * finite so even a misclassified failure stops instead of retrying for the session's lifetime.
 */
const bindBackoffMs = [500, 1000, 2000, 4000, 8000] as const
/** How often a page whose stream cannot reconnect asks the front door whether it still knows it. */
const LOST_PROBE_MS = 10_000
/** How long page changes are batched before one sync carries them all. */
const SYNC_DEBOUNCE_MS = 40
/** How long a sync the Host did not take waits before it is sent again. */
const SYNC_RETRY_MS = 500

/**
 * The zone this browser keeps time in, as the Host is told with every sync: it is what "today" means to
 * the person, and the agent has no other way to know it. Read each time, since a laptop changes zones.
 * @returns an IANA name such as `Asia/Shanghai`, or undefined where the browser will not say.
 */
export function browserTimeZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** What the workbench has on show. */
export interface PaneTarget {
  /** The Chat the pane binds to; undefined when no session is open. */
  readonly sessionId: string | undefined
  /** The Host holds no session at all, so none is about to be restored. */
  readonly noSessions: boolean
  readonly connectionId: ConnectionId
  /** The page the Host checks permissions against; a person's own menu entry reports the list it narrows. */
  readonly page: PageId
  /** Enterprise identity scope, for the menu mirror. */
  readonly scope: string
}

/** One session's binding: what `show` starts and stops. */
interface Binding {
  /** Whether the Host took the binding and a stream is open on it. */
  bound: boolean
  stop(): void
}

/** A terminal state for a binding the Host refused, so views can report it. */
function refused(message: string): PaneStreamState {
  return { commands: [], state: {}, status: 'rejected', error: message }
}

export class PaneService {
  /** What the pane reports of itself: the page's context and the commands it carried out. */
  readonly local = new PaneLocalStore()
  /** The published pane. One source for the plugin's lifetime, whichever session is bound. */
  readonly stream: PaneStreamStore = {
    getSnapshot: () => this.#state,
    subscribe: listener => {
      this.#listeners.add(listener)
      return () => {
        this.#listeners.delete(listener)
      }
    },
  }
  readonly #api: PaneRemote
  readonly #menu: MenuMirror
  readonly #t: OryhText
  readonly #lost: () => void
  readonly #instance = crypto.randomUUID()
  readonly #listeners = new Set<() => void>()
  readonly #offLocal: () => void
  #state: PaneStreamState = nothingBound
  #target: PaneTarget | undefined
  #binding: Binding | undefined
  // The revision counts on for as long as the service lives. A page change must not start it over: the
  // sync that carries the new page — and the acknowledgement of the command that opened it — would look
  // older than what the Host already has, and the Host would drop it.
  #revision = 0
  #syncTimer: ReturnType<typeof setTimeout> | undefined
  #inFlight = false
  #dirty = false
  #menuAsk = 0
  #menuOf: readonly unknown[] | undefined
  #disposed = false

  /**
   * @param api - the frame's pane Remote.
   * @param menu - where the menu the Host publishes is mirrored.
   * @param t - the frame's words, for what the service has to say itself.
   * @param lost - asks the front door whether it still knows this page; replaced in tests.
   */
  constructor(api: PaneRemote, menu: MenuMirror, t: OryhText, lost: () => void = () => void enterAgainIfLost()) {
    this.#api = api
    this.#menu = menu
    this.#t = t
    this.#lost = lost
    this.#offLocal = this.local.subscribe(() => this.#schedule())
  }

  /**
   * Say what the workbench has on show. A change of session or connection moves the binding; a change
   * of page only goes out with the next sync.
   * @param target - what is on show, or undefined when no workbench is.
   */
  show(target: PaneTarget | undefined): void {
    if (this.#disposed) return
    const was = this.#target
    this.#target = target
    const moved = was?.sessionId !== target?.sessionId || was?.connectionId !== target?.connectionId
    if (moved) {
      this.#binding?.stop()
      this.#binding = undefined
      this.#publish(nothingBound)
      if (target?.sessionId !== undefined) this.#binding = this.#bind(target.sessionId, target.connectionId)
    } else if (was?.page !== target?.page) this.#schedule()
    if (was?.scope !== target?.scope) this.#mirror()
    // With no session open nothing is bound, yet the role's entries do not depend on a session: a
    // person who has not opened Chat still needs the lists their permissions give them. With no session
    // at all, they are the whole menu until the person starts one.
    if (moved || was?.scope !== target?.scope || was?.noSessions !== target?.noSessions) {
      const ask = ++this.#menuAsk
      if (target !== undefined && target.sessionId === undefined)
        // Inside the chain, so even a synchronous failure only means no role entries yet.
        void Promise.resolve()
          .then(() => this.#api.paneMenu(target.connectionId))
          .then(
            views => {
              if (ask === this.#menuAsk) this.#menu.publishRole(target.scope, views, target.noSessions)
            },
            () => {},
          )
    }
  }

  /** Withdraw the binding and stop every timer; the plugin is going. */
  dispose(): void {
    this.show(undefined)
    this.#disposed = true
    this.#offLocal()
    if (this.#syncTimer !== undefined) clearTimeout(this.#syncTimer)
  }

  #publish(next: PaneStreamState): void {
    if (next === this.#state) return
    this.#state = next
    this.#mirror()
    for (const listener of [...this.#listeners]) listener()
  }

  /**
   * The role's entries, then what colleagues shared, then the person's own. Published only once all have
   * arrived: a reload restored to a role entry, or to a colleague's, must not read "not in the menu yet"
   * as "deleted" and send the person home.
   */
  #mirror(): void {
    const scope = this.#target?.scope
    const { userViews, roleViews, sharedViews, sharedOwn, sharedPending } = this.#state.state
    if (scope === undefined || !userViews || !roleViews || sharedPending) return
    const was = this.#menuOf
    if (
      was &&
      was[0] === scope &&
      was[1] === userViews &&
      was[2] === roleViews &&
      was[3] === sharedViews &&
      was[4] === sharedOwn
    )
      return
    this.#menuOf = [scope, userViews, roleViews, sharedViews, sharedOwn]
    const sharing = new Set(sharedOwn ?? [])
    const own = userViews.map(view => (sharing.has(view.id) ? { ...view, shared: true } : view))
    // `sharedViews` is there, even when empty, exactly where the deployment keeps a library.
    this.#menu.publish(scope, [...roleViews, ...(sharedViews ?? []), ...own], sharedViews !== undefined)
  }

  /**
   * Bind one session to its enterprise and follow the agent's commands for it.
   *
   * The bind has to land before the stream opens, because the Host refuses an unbound session.
   * Only transport failures are retried: a refusal the Host decided on will not change by asking
   * again, so it stops and publishes a terminal state instead of hiding behind a retry loop.
   * Stopping withdraws the binding.
   */
  #bind(session: string, connectionId: ConnectionId): Binding {
    let live = true,
      attempt = 0,
      established = false
    let timer: ReturnType<typeof setTimeout> | undefined,
      lost: ReturnType<typeof setInterval> | undefined,
      handle: PaneStreamHandle | undefined,
      unwatch: (() => void) | undefined
    const binding: Binding = {
      bound: false,
      stop: () => {
        live = false
        binding.bound = false
        if (timer !== undefined) clearTimeout(timer)
        if (lost !== undefined) clearInterval(lost)
        unwatch?.()
        void handle?.dispose()
        // Only withdraw a binding that was actually established. Clearing is keyed by session id alone,
        // so a binding that never landed would be withdrawing whatever now holds it.
        if (established) void this.#api.paneUnbind(session).catch(() => {})
      },
    }
    const bind = (): void => {
      void this.#api
        .paneBind({ sessionId: session, connectionId })
        .then(() => {
          if (!live) return
          established = true
          const opened = this.#api.openPane({ sessionId: session, connectionId })
          handle = opened
          // A stream the Host refuses outright is usually a Host that no longer holds this binding —
          // it restarted. Binding again is the recovery, and without it the pane stays deaf until the
          // person reloads the page, which they have no reason to do.
          //
          // Binding again is not what earns another round of tries, though: a Host that takes the binding
          // and then refuses every stream — a business refusal, a protocol error — would be asked twice a
          // second for as long as the page stayed open. Only a stream that delivered its state does; one
          // that keeps failing uses up the tries and is left refused, with its reason, for the person to see.
          const watch = opened.subscribe(() => {
            if (!live || handle !== opened) return
            const snapshot = opened.getSnapshot()
            const status = snapshot.status
            if (status === 'synced') attempt = 0
            // A page nobody is using notices a restarted control process here and nowhere else: its
            // stream keeps trying to reconnect and is refused each time, without ever being rejected.
            // While that lasts the front door is asked now and then whether it still knows this page.
            if (status === 'reconnecting') lost ??= setInterval(this.#lost, LOST_PROBE_MS)
            else if (lost !== undefined) {
              clearInterval(lost)
              lost = undefined
            }
            const wait = status === 'rejected' ? bindBackoffMs[attempt] : undefined
            if (wait === undefined) {
              this.#publish(snapshot)
              return
            }
            attempt++
            watch()
            unwatch = undefined
            handle = undefined
            void opened.dispose()
            binding.bound = false
            this.#publish(nothingBound)
            timer = setTimeout(bind, wait)
          })
          unwatch = watch
          opened.start()
          binding.bound = true
          this.#publish(opened.getSnapshot())
          this.#schedule()
        })
        .catch((error: unknown) => {
          if (!live) return
          const wait = error instanceof LocalRemoteError && error.business ? undefined : bindBackoffMs[attempt]
          if (wait === undefined) {
            this.#publish(
              refused(error instanceof Error && error.message.length > 0 ? error.message : this.#t('bindRefused')),
            )
            return
          }
          attempt++
          timer = setTimeout(bind, wait)
          // A control process that restarted refuses this page from now on; entering again recovers.
          if (attempt >= 2) this.#lost()
        })
    }
    bind()
    return binding
  }

  // The sync: whatever changed — page, context or acknowledgements — the Host gets the whole pane state
  // once, under the next revision. A failed sync is sent again with the latest state; the Host ignores
  // anything older than what it holds, so a late retry cannot roll it back.
  #schedule(wait = SYNC_DEBOUNCE_MS): void {
    if (this.#disposed || !this.#binding?.bound) return
    if (this.#syncTimer !== undefined) clearTimeout(this.#syncTimer)
    this.#syncTimer = setTimeout(() => void this.#send(), wait)
  }

  async #send(): Promise<void> {
    const target = this.#target
    const binding = this.#binding
    if (target?.sessionId === undefined || !binding?.bound) return
    if (this.#inFlight) {
      this.#dirty = true
      return
    }
    this.#inFlight = true
    this.#dirty = false
    const snapshot = this.local.getSnapshot()
    const timeZone = browserTimeZone()
    let retry = false
    try {
      await this.#api.paneSync({
        sessionId: target.sessionId,
        connectionId: target.connectionId,
        instance: this.#instance,
        revision: ++this.#revision,
        page: target.page,
        ...(snapshot.context ? { context: snapshot.context } : {}),
        ...(snapshot.acks.length ? { acks: [...snapshot.acks] } : {}),
        ...(timeZone ? { timeZone } : {}),
      })
      this.local.sent(snapshot.acks)
    } catch {
      retry = true
    } finally {
      this.#inFlight = false
      if (retry) this.#schedule(SYNC_RETRY_MS)
      else if (this.#dirty) this.#schedule()
    }
  }
}
