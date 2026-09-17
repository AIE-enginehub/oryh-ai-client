/** A pane for component tests: a synced stream whose frames the test publishes by hand, and a real local store. */
import type { AnyPaneCommand, PaneState } from '@oryh/dsh-pane/types'
import { PaneLocalStore } from './pane.js'
import type { PaneStreamState } from './pane-stream.js'

export function fakePane(initial: Partial<PaneStreamState> = {}) {
  let state: PaneStreamState = { commands: [], state: {}, status: 'synced', ...initial }
  const listeners = new Set<() => void>()
  const local = new PaneLocalStore()
  const stream = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const publish = (next: Partial<PaneStreamState>) => {
    state = { ...state, ...next }
    for (const listener of [...listeners]) listener()
  }
  return {
    value: { stream, local },
    local,
    publish,
    /** Publish one command as the only pending one. */
    command: (command: Omit<AnyPaneCommand, 'expiresAt'> & { expiresAt?: number }) =>
      publish({ commands: [{ expiresAt: Date.now() + 15_000, ...command } as AnyPaneCommand] }),
    /** Publish Host state beside whatever commands are pending. */
    state: (next: PaneState) => publish({ state: next }),
    /** The command ids the pane has acknowledged so far. */
    acked: () => local.getSnapshot().acks.map(a => a.id),
  }
}
