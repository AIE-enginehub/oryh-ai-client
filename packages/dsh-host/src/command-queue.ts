/** Page commands and the tool waits they settle: state syncs resolve them instead of polling loops. */
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { ChatNavigation } from './types.js'

/** One pending wait. `until` returns its receipt once the synced state satisfies the command. */
export interface CommandWait<R> {
  /** Receipt once the page state matches; undefined keeps waiting. */
  until: () => R | undefined
  /** Reason the command can no longer apply, checked before `until` on every settle. */
  invalid?: () => string | undefined
  /** Message when the page never acknowledged within the command's lifetime. */
  expired: string
  /** Command lifetime in milliseconds. */
  timeoutMs: number
  /** Tool cancellation. */
  signal: AbortSignal
}

interface Pending {
  settle: () => void
  fail: (message: string) => void
}

/**
 * Pending page commands plus the tool waits they settle.
 * One wait per session and lane: a new command on the same lane supersedes the previous one.
 */
export class CommandQueue {
  readonly #waits = new Map<string, Map<string, Pending>>()
  readonly #navigation = new Map<string, ChatNavigation>()
  readonly #listeners = new Map<string, Set<() => void>>()

  /**
   * Follow command changes for one session; the stream Remote republishes its snapshot on each.
   * @param sessionId - session to follow.
   * @param listener - called after any command is issued, withdrawn or cleared.
   * @returns unsubscribe.
   */
  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<() => void>()
    this.#listeners.set(sessionId, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(sessionId)
    }
  }

  /**
   * Notify followers that this session's pending commands changed.
   * @param sessionId - session whose commands changed, including a child's staged suggestion.
   */
  changed(sessionId: string): void {
    for (const listener of [...(this.#listeners.get(sessionId) ?? [])]) listener()
  }

  /**
   * Publish the navigation command browser views fetch for this session.
   * @param sessionId - owning session.
   * @param command - short-lived command; one per session, replacing any earlier one.
   */
  issue(sessionId: string, command: ChatNavigation): void {
    this.#navigation.set(sessionId, command)
    this.changed(sessionId)
  }

  /**
   * Read the pending navigation command.
   * @param sessionId - owning session.
   * @returns the command, or undefined once it expired or was withdrawn.
   */
  peek(sessionId: string): ChatNavigation | undefined {
    const command = this.#navigation.get(sessionId)
    return command !== undefined && command.expiresAt > Date.now() ? command : undefined
  }

  /**
   * Withdraw the session's navigation command.
   * @param sessionId - owning session.
   * @param id - withdraw only this exact command; omitted withdraws whichever is pending.
   */
  withdraw(sessionId: string, id?: string): void {
    const command = this.#navigation.get(sessionId)
    if (command === undefined) return
    if (id !== undefined && command.id !== id) return
    this.#navigation.delete(sessionId)
    this.changed(sessionId)
  }

  /**
   * Whether this exact command is still the session's pending one.
   * @param sessionId - owning session.
   * @param id - command id.
   * @returns true while that command is pending.
   */
  holds(sessionId: string, id: string): boolean {
    return this.#navigation.get(sessionId)?.id === id
  }

  /**
   * Wait for the page to acknowledge a command on one lane.
   * @param sessionId - owning session.
   * @param lane - command lane; a second wait on it supersedes the first.
   * @param wait - receipt predicate, invalidation check, lifetime and cancellation.
   * @returns the receipt `until` produced.
   * @throws when the command is invalidated, superseded, aborted or expires.
   */
  async wait<R>(sessionId: string, lane: string, wait: CommandWait<R>): Promise<R> {
    const lanes = this.#waits.get(sessionId) ?? new Map<string, Pending>()
    this.#waits.set(sessionId, lanes)
    lanes.get(lane)?.fail('已被新的指令取代。')
    return new Promise<R>((resolve, reject) => {
      const release = (): void => {
        clearTimeout(timer)
        wait.signal.removeEventListener('abort', abort)
        if (lanes.get(lane) === pending) lanes.delete(lane)
      }
      const abort = (): void => { release(); reject(wait.signal.reason) }
      const timer = setTimeout(() => {
        release()
        reject(new OryhClientError(wait.expired, 'request-failed'))
      }, wait.timeoutMs)
      const pending: Pending = {
        settle: () => {
          const invalid = wait.invalid?.()
          if (invalid !== undefined) { release(); reject(new OryhClientError(invalid, 'request-failed')); return }
          const receipt = wait.until()
          if (receipt !== undefined) { release(); resolve(receipt) }
        },
        fail: (message) => { release(); reject(new OryhClientError(message, 'request-failed')) },
      }
      lanes.set(lane, pending)
      if (wait.signal.aborted) { abort(); return }
      wait.signal.addEventListener('abort', abort, { once: true })
      // The page may already satisfy the command; settling now avoids waiting for the next sync.
      pending.settle()
    })
  }

  /**
   * Re-evaluate every wait for one session. Called after any page or form state sync.
   * @param sessionId - session whose state just changed.
   */
  settle(sessionId: string): void {
    for (const pending of [...(this.#waits.get(sessionId)?.values() ?? [])]) pending.settle()
  }

  /**
   * Drop the session's pending command and fail its waits.
   * @param sessionId - session leaving its page or binding.
   * @param message - failure reported to the waiting tools.
   */
  clear(sessionId: string, message = '页面已改变。'): void {
    this.#navigation.delete(sessionId)
    for (const pending of [...(this.#waits.get(sessionId)?.values() ?? [])]) pending.fail(message)
    this.#waits.delete(sessionId)
    this.changed(sessionId)
  }

  /** Release every session's commands and waits on plugin unload. */
  disposeAll(): void {
    for (const sessionId of [...this.#waits.keys()]) this.clear(sessionId, 'ORYH 插件已卸载。')
    this.#navigation.clear()
    this.#waits.clear()
  }
}
