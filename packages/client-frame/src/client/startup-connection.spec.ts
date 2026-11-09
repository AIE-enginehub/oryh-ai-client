// @vitest-environment jsdom
import { LocalRemoteError } from '@oryh/ai-client-kit'
import { dictionaries } from '@oryh/ai-client-kit/dictionary'
import { wordsOf } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { App } from './app.js'
import type { FrameEnv } from './workbench.js'

vi.mock('./workbench.js', () => ({ Workbench: () => h('div', { 'data-testid': 'restored' }, 'connected') }))

const connection = {
  id: 'saved',
  origin: 'https://oryh.example',
  identity: { tenant: { id: 't', name: 'Test' }, user: { id: 'u', email: 'user@example.test' }, permissions: [] },
}
const timeout = () =>
  new LocalRemoteError('gateway/internal', 'client api: oryh/listConnections failed: Failed to fetch')

async function mount(listConnections: () => Promise<unknown>) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const remote = {
    connectionDefaults: vi.fn(async () => ({ origin: connection.origin })),
    listConnections: vi.fn(listConnections),
    listOperations: vi.fn(async () => []),
    listSavedOperations: vi.fn(async () => []),
    verifyConnection: vi.fn(async () => connection),
  }
  const env = { remote, t: wordsOf(dictionaries), useMenu: () => undefined } as unknown as FrameEnv
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const identity = vi.fn()
  await act(async () => root.render(h(App, { env, dark: false, page: 'my-open-todos', onIdentity: identity })))
  return { node, root, remote, identity }
}

it('automatically restores after the five-minute request times out and authorization completes later', async () => {
  vi.useFakeTimers()
  let authorized = false,
    attempts = 0
  const f = await mount(async () => {
    if (++attempts === 1) return new Promise((_, reject) => setTimeout(() => reject(timeout()), 300_000))
    return new Promise(resolve =>
      setTimeout(() => {
        authorized = true
        resolve([connection])
      }, 31_000),
    )
  })
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000)
    })
    expect(f.node.querySelector('[data-testid=restored]')).toBeNull()
    expect(f.node.textContent).not.toContain('Failed to fetch')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(f.remote.listConnections).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(authorized).toBe(true)
    expect(f.node.querySelector('[data-testid=restored]')).not.toBeNull()
    expect(f.identity.mock.calls.at(-1)?.[0]?.email).toBe(connection.identity.user.email)
    expect(f.remote.verifyConnection).toHaveBeenCalledWith(connection.id)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(f.remote.listConnections).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => f.root.unmount())
    f.node.remove()
    vi.useRealTimers()
  }
})

it.each(['credential-store-failed', 'authentication-failed', 'connection-identity-mismatch'])(
  'does not retry the Host business refusal %s',
  async code => {
    vi.useFakeTimers()
    const f = await mount(async () => {
      throw new LocalRemoteError(code, 'Explicit refusal', true)
    })
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000)
      })
      expect(f.remote.listConnections).toHaveBeenCalledTimes(1)
      expect(f.node.querySelector('input')).not.toBeNull()
      expect(f.node.querySelector('[data-testid=restored]')).toBeNull()
    } finally {
      await act(async () => f.root.unmount())
      f.node.remove()
      vi.useRealTimers()
    }
  },
)

it('cancels scheduled retry when the frame unmounts', async () => {
  vi.useFakeTimers()
  const f = await mount(async () => {
    throw timeout()
  })
  await act(async () => f.root.unmount())
  await vi.advanceTimersByTimeAsync(600_000)
  expect(f.remote.listConnections).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  f.node.remove()
  vi.useRealTimers()
})
