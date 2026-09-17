import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

describe('the ORYH connection plugin', () => {
  it('rejects relative persistence paths and unvalidated production composition', async () => {
    const ctx = new Context()
    expect(() => plugin.apply(ctx, { developmentOnly: true, dataDirectory: './data' })).toThrow(/absolute path/)
    // The server never composes this plugin: its bundle disables the row and runs the server Host instead.
    expect(() => plugin.apply(ctx, { developmentOnly: false })).toThrow(/developmentOnly/)
  })

  it('carries a business failure across the Gateway with its code, and refuses once unloaded', async () => {
    const { OryhClientError } = await import('@oryh/ai-client-foundation')
    let unload: (() => Promise<void>) | undefined
    const ctx = {
      effect: (fn: () => () => Promise<void>) => {
        unload = fn()
      },
    } as unknown as Context
    const calls = new plugin.RemoteCalls(ctx, 'oryh')
    expect(await calls.call(() => 1)).toBe(1)
    await expect(
      calls.call(() => {
        throw new OryhClientError('没有权限', 'permission-denied')
      }),
    ).rejects.toMatchObject({ code: 'oryh/business', details: { code: 'permission-denied' } })
    await expect(
      calls.call(() => {
        throw new Error('secret internals')
      }),
    ).rejects.toMatchObject({ code: 'oryh/business', message: expect.not.stringContaining('secret') })
    await unload?.()
    await expect(calls.call(() => 1)).rejects.toMatchObject({ code: 'oryh/business' })
  })
})
