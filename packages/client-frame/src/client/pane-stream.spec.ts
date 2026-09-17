/** Client stream adapter: how Harness's supervision maps onto published pane state. */

import { RemoteStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { AnyPaneCommand, PaneFrame } from '@oryh/dsh-pane/types'
import { describe, expect, it } from 'vitest'
import type { PaneStreamHandle, PaneStreamState } from './pane-stream.js'
import { createFrameRemote } from './remote.js'

const navigation: AnyPaneCommand = {
  lane: 'navigation',
  id: 'n1',
  page: 'timesheets',
  payload: { target: 'timesheet', page: 'timesheets' },
  expiresAt: Date.now() + 60_000,
}
const baseline = (commands: AnyPaneCommand[]): PaneFrame => ({ type: 'baseline', commands, state: {} })
const update = (commands: AnyPaneCommand[]): PaneFrame => ({ type: 'update', commands, state: {} })

/** Keep a generation open until its own signal aborts, so it never ends on its own. */
function hold(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

/** One physical generation's frames; `attempt` counts from 0 so a test can differ per reopen. */
type Generation = (attempt: number, signal: AbortSignal) => AsyncIterable<PaneFrame>

/**
 * A Remote whose `$stream` builds a real `RemoteStream`, so the retry classification and
 * baseline protocol under test are Harness's own and not a local imitation. `generation`
 * reports a live connection, which is what makes a carrier loss retry immediately.
 */
function fakeRemote(generations: Generation): { handle: PaneStreamHandle; opens: () => number } {
  let attempt = 0
  const connection = { generation: { getSnapshot: () => 1, subscribe: () => () => {} } }
  const remote = {
    $stream: (options: unknown) => new RemoteStream(connection as never, options as never),
    oryhPane: { paneCommands: (_request: unknown, signal: AbortSignal) => generations(attempt++, signal) },
  }
  const api = createFrameRemote(remote as never)
  return {
    handle: api.openPane({ sessionId: 's', connectionId: 'c' as ConnectionId }),
    opens: () => attempt,
  }
}

/** Drive timers until the published state satisfies `predicate`. */
async function until(
  handle: PaneStreamHandle,
  predicate: (state: PaneStreamState) => boolean,
): Promise<PaneStreamState> {
  for (let tick = 0; tick < 400; tick++) {
    const state = handle.getSnapshot()
    if (predicate(state)) return state
    await new Promise(resolve => {
      setTimeout(resolve, 1)
    })
  }
  throw new Error(`stream never reached the expected state, last was ${JSON.stringify(handle.getSnapshot())}`)
}

describe('pane stream adapter', () => {
  it('publishes the whole set from a baseline and follows it with updates', async () => {
    const { handle } = fakeRemote(async function* (_attempt, signal) {
      yield baseline([navigation])
      yield update([])
      await hold(signal)
    })
    // Both frames land in one microtask burst, so the sequence is captured rather than polled.
    const seen: PaneStreamState[] = []
    handle.subscribe(() => {
      seen.push(handle.getSnapshot())
    })
    handle.start()
    try {
      await until(handle, s => s.status === 'synced' && s.commands.length === 0)
      expect(seen.map(state => state.status)).toEqual(['synced', 'synced'])
      expect(seen[0]?.commands).toEqual([navigation])
      expect(seen[1]?.commands).toEqual([])
    } finally {
      await handle.dispose()
    }
  })

  it('recovers from a carrier loss before the first baseline instead of ending the linkage', async () => {
    const { handle, opens } = fakeRemote((attempt, signal) =>
      attempt === 0
        ? (async function* (): AsyncIterable<PaneFrame> {
            throw new RemoteStreamCarrierError('socket lost')
          })()
        : (async function* () {
            yield baseline([navigation])
            await hold(signal)
          })(),
    )
    handle.start()
    try {
      expect((await until(handle, s => s.status === 'synced')).commands).toEqual([navigation])
      expect(opens()).toBeGreaterThan(1)
    } finally {
      await handle.dispose()
    }
  })

  it('keeps the last set published while reconnecting after a carrier loss', async () => {
    const { handle } = fakeRemote((attempt, signal) =>
      attempt === 0
        ? (async function* (): AsyncIterable<PaneFrame> {
            yield baseline([navigation])
            throw new RemoteStreamCarrierError('socket lost')
          })()
        : (async function* () {
            yield baseline([navigation])
            await hold(signal)
          })(),
    )
    const seen: PaneStreamState[] = []
    handle.subscribe(() => {
      seen.push(handle.getSnapshot())
    })
    handle.start()
    try {
      await until(handle, s => s.status === 'synced' && seen.some(e => e.status === 'reconnecting'))
      const reconnecting = seen.find(state => state.status === 'reconnecting')
      // A command the page has not acted on must survive the reconnect, not blink out of view.
      expect(reconnecting?.commands).toEqual([navigation])
    } finally {
      await handle.dispose()
    }
  })

  it('treats a non-carrier failure as terminal and stops publishing stale commands', async () => {
    const { handle } = fakeRemote(async function* (): AsyncIterable<PaneFrame> {
      yield baseline([navigation])
      throw new Error('会话尚未绑定企业。')
    })
    handle.start()
    try {
      const state = await until(handle, s => s.status === 'rejected')
      expect(state.error).toContain('会话尚未绑定企业。')
      // Terminal means the command is no longer a valid instruction for the page.
      expect(state.commands).toEqual([])
    } finally {
      await handle.dispose()
    }
  })

  it('rejects an update that arrives before its opening snapshot', async () => {
    const { handle } = fakeRemote(async function* (_attempt, signal) {
      yield update([navigation])
      await hold(signal)
    })
    handle.start()
    try {
      const state = await until(handle, s => s.status === 'rejected')
      expect(state.error).toContain('opening snapshot')
      expect(state.commands).toEqual([])
    } finally {
      await handle.dispose()
    }
  })
})
