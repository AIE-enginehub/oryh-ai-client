/** Pending pane commands, by lane, and the tool waits they settle: state syncs resolve them instead of polling loops. */
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { AnyPaneCommand } from './types.js'

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
 *
 * A session holds at most one command per lane: a new command on the same lane supersedes the
 * previous one, and a wait on that lane fails when it is superseded. Every change notifies the
 * session's followers, which is how the pane stream learns to send a new frame.
 */
export class CommandQueue {
  readonly #waits = new Map<string, Map<string, Pending>>()
  readonly #commands = new Map<string, Map<string, AnyPaneCommand>>()
  readonly #listeners = new Map<string, Set<() => void>>()

  /**
   * Follow command changes for one session; the stream Remote republishes its frame on each.
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
   * Notify followers that this session's published set changed.
   * @param sessionId - session whose commands or state changed.
   */
  changed(sessionId: string): void {
    for (const listener of [...(this.#listeners.get(sessionId) ?? [])]) listener()
  }

  /**
   * Publish a command for the page, replacing any earlier one on its lane.
   * @param sessionId - owning session.
   * @param command - short-lived command.
   */
  issue(sessionId: string, command: AnyPaneCommand): void {
    const lanes = this.#commands.get(sessionId) ?? new Map<string, AnyPaneCommand>()
    this.#commands.set(sessionId, lanes)
    lanes.set(command.lane, command)
    this.changed(sessionId)
  }

  /**
   * Read the pending command on one lane.
   * @param sessionId - owning session.
   * @param lane - command lane.
   * @returns the command, or undefined once it expired or was withdrawn.
   */
  peek(sessionId: string, lane: string): AnyPaneCommand | undefined {
    const command = this.#commands.get(sessionId)?.get(lane)
    return command !== undefined && command.expiresAt > Date.now() ? command : undefined
  }

  /**
   * Every pending, unexpired command of one session.
   * @param sessionId - owning session.
   * @returns the commands, one per lane.
   */
  list(sessionId: string): AnyPaneCommand[] {
    const now = Date.now()
    return [...(this.#commands.get(sessionId)?.values() ?? [])].filter(command => command.expiresAt > now)
  }

  /**
   * Withdraw a lane's command.
   * @param sessionId - owning session.
   * @param lane - command lane.
   * @param id - withdraw only this exact command; omitted withdraws whichever is pending.
   */
  withdraw(sessionId: string, lane: string, id?: string): void {
    const lanes = this.#commands.get(sessionId)
    const command = lanes?.get(lane)
    if (lanes === undefined || command === undefined) return
    if (id !== undefined && command.id !== id) return
    lanes.delete(lane)
    if (lanes.size === 0) this.#commands.delete(sessionId)
    this.changed(sessionId)
  }

  /**
   * Whether this exact command is still pending on its lane.
   * @param sessionId - owning session.
   * @param lane - command lane.
   * @param id - command id.
   * @returns true while that command is pending.
   */
  holds(sessionId: string, lane: string, id: string): boolean {
    return this.#commands.get(sessionId)?.get(lane)?.id === id
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
      const abort = (): void => {
        release()
        reject(wait.signal.reason)
      }
      const timer = setTimeout(() => {
        release()
        reject(new OryhClientError(wait.expired, 'request-failed'))
      }, wait.timeoutMs)
      const pending: Pending = {
        settle: () => {
          const invalid = wait.invalid?.()
          if (invalid !== undefined) {
            release()
            reject(new OryhClientError(invalid, 'request-failed'))
            return
          }
          const receipt = wait.until()
          if (receipt !== undefined) {
            release()
            resolve(receipt)
          }
        },
        fail: message => {
          release()
          reject(new OryhClientError(message, 'request-failed'))
        },
      }
      lanes.set(lane, pending)
      if (wait.signal.aborted) {
        abort()
        return
      }
      wait.signal.addEventListener('abort', abort, { once: true })
      // The page may already satisfy the command; settling now avoids waiting for the next sync.
      pending.settle()
    })
  }

  /**
   * Re-evaluate every wait for one session. Called after any page state sync.
   * @param sessionId - session whose state just changed.
   */
  settle(sessionId: string): void {
    for (const pending of [...(this.#waits.get(sessionId)?.values() ?? [])]) pending.settle()
  }

  /**
   * Drop the session's pending commands and fail its waits.
   * @param sessionId - session leaving its page or binding.
   * @param message - failure reported to the waiting tools.
   */
  clear(sessionId: string, message: string = '页面已改变。'): void {
    this.#commands.delete(sessionId)
    for (const pending of [...(this.#waits.get(sessionId)?.values() ?? [])]) pending.fail(message)
    this.#waits.delete(sessionId)
    this.changed(sessionId)
  }

  /** Release every session's commands and waits on plugin unload. */
  disposeAll(): void {
    for (const sessionId of [...new Set([...this.#waits.keys(), ...this.#commands.keys()])])
      this.clear(sessionId, 'ORYH 插件已卸载。')
    this.#commands.clear()
    this.#waits.clear()
  }
}
