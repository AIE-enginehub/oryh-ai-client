/** A pane for component tests: a synced stream whose frames the test publishes by hand, and a real local store. */
import type { AnyPaneCommand, PaneState } from '@oryh/dsh-pane/types'
import { useSyncExternalStore } from 'react'
import { dictionaries } from './dictionary.js'
import type { FrameShare, PageFace } from './frame.js'
import { type PaneFace, PaneLocalStore, type PaneStreamState, type SelectHook } from './pane.js'
import type { FrameRemote } from './remote.js'
import type { PreferenceStore, Preferences } from './view-preferences.js'

const idle = () => () => {}

/**
 * A hook over a source, as the renderer makes one for a slot's `hooks`. For tests, which have no renderer.
 * @param source - what to follow.
 */
export function sourceHook<T>(source: {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}): SelectHook<T> {
  return selector => selector(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
}

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
    value: { usePane: sourceHook(stream), usePaneLocal: sourceHook(local), local } as PaneFace,
    stream,
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

/**
 * A dictionary as the locale service would speak it: the word under a key, its `{name}` places filled.
 * @param words - the dictionary.
 */
export function wordsOf<Key extends string>(
  words: Record<Key, string>,
): (key: Key, params?: Record<string, unknown>) => string {
  return (key, params) => words[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

/**
 * What a page's slot hands it, for component tests: a {@link fakePane}, a connection, and a frame share
 * whose words are the real dictionary's. A test replaces what it is about.
 * @param given - the pane's opening state, and whatever of the face the test supplies.
 */
export function fakeFace(
  given: { pane?: Partial<PaneStreamState>; connection?: unknown; remote?: unknown; frame?: Partial<FrameShare> } = {},
) {
  const pane = fakePane(given.pane)
  // The frame's registry of kept preferences, and the keyed hook the renderer would make over it.
  const stores = new Map<string, PreferenceStore>()
  const prefs: Preferences = {
    open: (name, make) => {
      if (!stores.has(name)) stores.set(name, make())
    },
    set: (name, next) => stores.get(name)?.set(next),
    get: name => stores.get(name)?.getSnapshot(),
  }
  const face: PageFace = {
    ...pane.value,
    connection: (given.connection ?? {
      id: 'c',
      origin: 'https://oryh.test',
      identity: { tenant: { id: 't' }, user: { id: 'u' } },
    }) as PageFace['connection'],
    remote: (given.remote ?? {}) as FrameRemote,
    prefs,
    frame: {
      sessionId: 's',
      navigate: () => {},
      chat: { startSession: () => false, showChat: () => {}, showSession: () => {} },
      activity: 'none',
      menu: { views: [], loaded: true },
      t: wordsOf(dictionaries),
      usePreference: name => {
        const store = stores.get(name)
        return useSyncExternalStore(store?.subscribe ?? idle, () => store?.getSnapshot())
      },
      ...given.frame,
    },
  }
  return { ...pane, face }
}
