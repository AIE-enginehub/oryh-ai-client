// @vitest-environment jsdom
import { dictionaries } from '@oryh/ai-client-kit/dictionary'
import { wordsOf } from '@oryh/ai-client-kit/testing'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { App } from './app.js'
import type { FrameEnv } from './workbench.js'

// The connection screen owns its workflow; business pages are covered by workbench tests.
vi.mock('./workbench.js', () => ({
  Workbench: ({ settings, notices }: { settings: unknown; notices: unknown }) =>
    h('div', null, settings as never, notices as never),
}))

it('distinguishes same-server account authorization from switching servers, and keeps the current connection on cancel or failure', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const old = {
    id: 'old',
    origin: 'https://old.oryh.test',
    identity: { tenant: { id: 't', name: 'Test' }, user: { id: 'u', email: 'user@oryh.test' }, permissions: [] },
  }
  const remote = {
    connectionDefaults: vi.fn(async () => ({ origin: old.origin })),
    listConnections: vi.fn(async () => [old]),
    listOperations: vi.fn(async () => []),
    listSavedOperations: vi.fn(async () => []),
    verifyConnection: vi.fn(async () => old),
    beginConnection: vi.fn(async () => {
      throw new Error('Connection unavailable')
    }),
    pollConnection: vi.fn(),
    disconnect: vi.fn(),
  }
  const identity = vi.fn()
  const env = { remote, t: wordsOf(dictionaries), useMenu: () => undefined } as unknown as FrameEnv
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const button = (label: string) => [...node.querySelectorAll('button')].find(b => b.textContent === label)!
  try {
    await act(async () => root.render(h(App, { env, dark: false, page: 'settings', onIdentity: identity })))
    await vi.waitFor(() => expect(button('切换账号')).toBeDefined())
    expect(node.textContent).toContain('服务器地址不变')
    expect(node.textContent).not.toContain('断开本地连接')
    await act(async () => button('切换账号').click())
    expect(remote.beginConnection).toHaveBeenLastCalledWith(old.origin, 'ORYH AI Client')
    await act(async () => button('切换服务器').click())
    expect(node.querySelector('h1')?.textContent).toBe('切换服务器')
    const input = node.querySelector('input')!
    expect(input.value).toBe('')
    await act(async () => button('返回当前服务器').click())
    expect(button('切换账号')).toBeDefined()
    expect(remote.disconnect).not.toHaveBeenCalled()
    await act(async () => button('切换服务器').click())
    const server = node.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(server, 'https://new.oryh.test')
      server.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('开始连接').click())
    expect(remote.beginConnection).toHaveBeenLastCalledWith('https://new.oryh.test', 'ORYH AI Client')
    expect(node.textContent).toContain('Connection unavailable')
    expect(node.querySelector('h1')?.textContent).toBe('切换服务器')
    await act(async () => button('返回当前服务器').click())
    expect(identity.mock.calls.at(-1)?.[0]?.email).toBe(old.identity.user.email)
    expect(remote.disconnect).not.toHaveBeenCalled()
    // Successful authorization activates the new server, with the previous connection kept.
    const next = { ...old, id: 'new', origin: 'https://new.oryh.test' }
    remote.beginConnection.mockResolvedValueOnce({
      authorizationId: 'authorization-test',
      prompt: {
        userCode: 'TEST-CODE',
        verificationUri: next.origin,
        verificationUriComplete: next.origin,
        expiresInSeconds: 900,
        pollIntervalSeconds: 0.001,
      },
    } as never)
    remote.pollConnection.mockResolvedValueOnce({ state: 'connected', connection: next })
    remote.listConnections.mockResolvedValueOnce([old, next])
    remote.verifyConnection.mockImplementation(async (...args: unknown[]) => (args[0] === next.id ? next : old))
    await act(async () => button('切换服务器').click())
    const nextInput = node.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nextInput, next.origin)
      nextInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    vi.useFakeTimers()
    await act(async () => button('开始连接').click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(remote.pollConnection).toHaveBeenCalled()
    expect(identity.mock.calls.at(-1)?.[0]?.scope).toContain(next.origin)
    expect(node.querySelector('h1')).toBeNull()
    expect(button('切换账号')).toBeDefined()
    expect(node.querySelectorAll('select option')).toHaveLength(3)
    expect(node.textContent).toContain(old.origin)
    expect(remote.disconnect).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    node.remove()
    vi.useRealTimers()
  }
})

it('offers saved accounts on the first launch before a native Profile is selected, without reauthorizing or publishing the wrong identity', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const first = {
    id: 'a',
    origin: 'https://a.oryh.test',
    identity: { tenant: { id: 't', name: 'A' }, user: { id: 'u', email: 'a@oryh.test' }, permissions: [] },
  }
  const second = { ...first, id: 'b', origin: 'https://b.oryh.test' }
  const remote = {
    connectionDefaults: vi.fn(async () => ({ origin: '' })),
    listConnections: vi.fn(async () => [first, second]),
    listOperations: vi.fn(async () => []),
    listSavedOperations: vi.fn(async () => []),
    verifyConnection: vi.fn(async () => second),
    activateProfile: vi.fn(async () => false),
    beginConnection: vi.fn(),
  }
  const identity = vi.fn()
  const env = { remote, t: wordsOf(dictionaries), useMenu: () => undefined } as unknown as FrameEnv
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  try {
    await act(async () => root.render(h(App, { env, dark: false, page: 'my-open-todos', onIdentity: identity })))
    const select = node.querySelector('select')!
    expect(select).not.toBeNull()
    expect([...select.options].map(option => option.value)).toEqual(['', 'a', 'b'])
    expect(select.value).toBe('')
    await act(async () => {
      select.value = 'b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(remote.verifyConnection).toHaveBeenCalledWith('b')
    expect(remote.activateProfile).toHaveBeenCalledWith('b')
    expect(remote.beginConnection).not.toHaveBeenCalled()
    expect(identity.mock.calls.every(([value]) => value === undefined)).toBe(true)
  } finally {
    await act(async () => root.unmount())
    node.remove()
  }
})
