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

  it("has the deployment's directory ready as a workspace, and only logs when Harness will not take it", async () => {
    const made: [string, string | undefined][] = []
    const withRegistry = (create: (path: string, title?: string) => Promise<unknown>) =>
      ({
        inject: (names: string[], run: (inner: unknown) => void) => {
          expect(names).toEqual(['workspaceRegistry'])
          run({ workspaceRegistry: { create } })
        },
      }) as unknown as Context
    plugin.readyWorkspace(
      withRegistry(async (path, title) => {
        made.push([path, title])
        return { title, setTitle: async () => {} }
      }),
      '/home/node/workspace',
    )
    expect(made).toEqual([['/home/node/workspace', 'ORYH']])
    // Refused — a directory that is gone, say — the Host starts all the same, and the person picks one.
    const warned: unknown[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warned.push(args[0])
    try {
      plugin.readyWorkspace(
        withRegistry(async () => {
          throw new Error('no such directory')
        }),
        '/gone',
      )
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      console.warn = warn
    }
    expect(String(warned[0])).toContain('no such directory')
  })

  it('migrates the titles it once generated, in either language, but preserves custom workspace titles', async () => {
    for (const title of ['我的工作区', 'My workspace', 'Sales workspace', '自定义工作区']) {
      const renamed: string[] = []
      const ctx = {
        inject: (_: string[], run: (inner: unknown) => void) =>
          run({
            workspaceRegistry: {
              create: async () => ({
                title,
                setTitle: async (next: string) => {
                  renamed.push(next)
                },
              }),
            },
          }),
      } as unknown as Context
      plugin.readyWorkspace(ctx, '/home/node/workspace')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(renamed).toEqual(title === '我的工作区' || title === 'My workspace' ? ['ORYH'] : [])
    }
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
    ).rejects.toMatchObject({
      code: 'oryh/business',
      message: 'ORYH could not complete the request. Please try again.',
    })
    await unload?.()
    await expect(calls.call(() => 1)).rejects.toMatchObject({
      code: 'oryh/business',
      message: 'The ORYH plugin has been unloaded.',
    })
  })
})
