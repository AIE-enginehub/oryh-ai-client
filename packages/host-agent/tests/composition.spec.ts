import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as connection from '@oryh/dsh-connection'
import { TYPERT_REMOTE as CONNECTION_REMOTE } from '@oryh/dsh-connection/remote'
import { TYPERT as CONNECTION } from '@oryh/dsh-connection/typert'
import * as pane from '@oryh/dsh-pane'
import { TYPERT as PANE } from '@oryh/dsh-pane/typert'
import * as records from '@oryh/dsh-records'
import { TYPERT as RECORDS } from '@oryh/dsh-records/typert'
import * as todos from '@oryh/dsh-todos'
import { TYPERT as TODOS } from '@oryh/dsh-todos/typert'
import { describe, expect, it, vi } from 'vitest'
import * as agent from '../src/index.js'

/**
 * The bundle's Host side, in the order `cordis.patch.yml` loads it — without `@oryh/dsh-analytics`, which
 * needs Harness's subagent, storage and model services to start; its composition is covered where a real
 * Profile starts (packages/server/test/custom-page-runner.process.test.ts). The timesheet, expense and
 * project plugins are not in the bundle and so not here.
 */
const PLUGINS = [pane, todos, records, agent]
const TYPERTS = [CONNECTION, PANE, TODOS, RECORDS]

describe('the ORYH Host plugins composed', () => {
  it('run their generated Remotes through real Cordis and Gateway, and go down with the connection', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'oryh-dsh-plugins-'))
    const ctx = new Context()
    try {
      await ctx
        .plugin(LocalCredentialProvider, { path: join(dataDirectory, '.credentials.yaml'), watch: false })
        .await()
      await ctx.plugin(TypertRegistry)
      await ctx.plugin(RemoteAccess)
      await ctx.plugin(Gateway)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(Tools, {})
      ctx.provide('agents', { list: () => [], get: () => undefined } as never)
      // Every bundle carries the Harness attachment store (attachment-local); the agent files from it.
      ctx.provide('attachments', { readImage: async () => ({}), readFileStream: async function* () {} } as never)
      for (const typert of TYPERTS) ctx.get('typert').register(typert)
      const fiber = ctx.plugin(connection, { developmentOnly: true, dataDirectory })
      await fiber
      for (const plugin of PLUGINS) await ctx.plugin(plugin)
      const removeRestriction = vi.fn()
      const restrict = vi.fn(() => removeRestriction)
      await ctx.serial('agent/created', {
        agent: {
          id: 'agent',
          ctx: { tools: { restrict, presentAs: () => () => {} }, systemPrompt: { context: () => () => {} } },
        },
        source: 'startup',
      } as never)
      // The allow-list is the pages' contributions, not a list kept in the agent. `skill`, `bash` and
      // `ask_user_question` are the preset's tools, which nothing here registers: with Harness's real
      // tool registry a restriction naming them would be refused whole, so they are left out of it — and
      // the rest of the policy stands, which is what this asserts.
      const allowed = (restrict.mock.calls.at(-1)![0] as { allow: string[] }).allow
      expect([...allowed].sort()).toEqual(
        [
          'oryh_skill_sync',
          agent.SKILL_FILE_TOOL,
          'oryh_read_attachment',
          agent.UPLOAD_TOOL,
          ...pane.PANE_TOOLS,
          ...pane.FORM_TOOLS,
          'oryh_review_result',
          ...todos.TODO_TOOLS,
          ...records.RECORD_TOOLS,
        ].sort(),
      )
      for (const name of allowed) expect(ctx.get('tools').get(name), name).toBeDefined()
      // The desktop keeps no library colleagues share through: the agent is not offered sharing at all.
      expect(allowed).not.toContain('oryh_menu_share')
      expect(allowed).not.toContain('oryh_menu_copy')
      expect(ctx.get('oryhChat')!.instructions()).not.toContain('oryh_menu_share')
      // A deployment that keeps one offers it, and takes it back with the library.
      const library = { list: async () => [], get: async () => undefined, onChanged: () => () => {} }
      const withdraw = ctx.provide('oryhLibrary', library as never)
      await vi.waitFor(() =>
        expect((restrict.mock.calls.at(-1)![0] as { allow: string[] }).allow).toContain('oryh_menu_share'),
      )
      expect(ctx.get('oryhChat')!.instructions()).toContain('oryh_menu_share')
      withdraw()
      await vi.waitFor(() =>
        expect((restrict.mock.calls.at(-1)![0] as { allow: string[] }).allow).not.toContain('oryh_menu_share'),
      )
      expect(await ctx.waterfall('tools/pre-execute', {} as never, async () => ({ kind: 'allow' }))).toMatchObject({
        kind: 'deny',
      })
      const peer: PeerScope = {
        id: 'oryh-composition' as PeerId,
        ctx,
        principal: { kind: 'owner' },
        signal: new AbortController().signal,
        interactions: 'none',
        dispose: async () => {},
      }
      const invoke = (namespace: string, method: string, args: Record<string, unknown> = {}) =>
        ctx.get('typertGateway').invoke({ namespace, method, args, peer })
      const previousOrigin = process.env.ORYH_SERVER_ORIGIN
      try {
        process.env.ORYH_SERVER_ORIGIN = 'https://oryh.example.test/'
        expect(await invoke('oryh', 'connectionDefaults')).toEqual({ origin: 'https://oryh.example.test' })
        process.env.ORYH_SERVER_ORIGIN = 'https://user:secret@example.com'
        await expect(invoke('oryh', 'connectionDefaults')).rejects.toThrow()
        delete process.env.ORYH_SERVER_ORIGIN
        expect(await invoke('oryh', 'connectionDefaults')).toEqual({ origin: '' })
      } finally {
        if (previousOrigin === undefined) delete process.env.ORYH_SERVER_ORIGIN
        else process.env.ORYH_SERVER_ORIGIN = previousOrigin
      }
      expect(await invoke('oryh', 'listConnections')).toEqual([])
      await expect(
        invoke('oryhTodos', 'todoDetail', { request: { connectionId: 'unknown', todoId: 't' } }),
      ).rejects.toMatchObject({ code: 'oryh/business' })
      await expect(
        invoke('oryhPane', 'paneBind', { request: { connectionId: 'unknown', sessionId: 42 } }),
      ).rejects.toMatchObject({ code: 'gateway/input-invalid' })
      await expect(
        invoke('oryhPane', 'paneBind', { request: { connectionId: 'unknown', sessionId: 'nobody' } }),
      ).rejects.toMatchObject({ code: 'oryh/business' })
      expect(await invoke('oryh', 'listOperations')).toHaveLength(1)
      // The public generated Remote carries MCP results without pretending they are disk installs.
      const skillResult = { delivery: 'mcp' as const, skills: ['oryh-test'], message: 'Refreshed' }
      const refresh = vi.spyOn(ctx.get('oryhSkills'), 'sync').mockResolvedValue(skillResult)
      expect(await invoke('oryh', 'skillSync', { request: { connectionId: 'bound', force: true } })).toEqual(
        skillResult,
      )
      expect(refresh).toHaveBeenCalledWith('bound', true)
      refresh.mockRestore()
      await expect(
        invoke('oryhRecords', 'recordFilterFields', { r: { connectionId: 'unknown', kind: 'shipments' } }),
      ).rejects.toMatchObject({
        code: 'oryh/business',
      })
      await expect(invoke('oryh', 'listConnections', { extra: 'not accepted' })).rejects.toThrow()
      let inFlight: AbortSignal | undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input, init) =>
          new Promise((_resolve, reject) => {
            inFlight = init?.signal ?? undefined
            inFlight?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          }),
      )
      const cancelled = expect(
        invoke('oryh', 'beginConnection', { request: { origin: 'http://localhost:8080', clientName: 'test' } }),
      ).rejects.toMatchObject({ code: 'oryh/business' })
      await vi.waitFor(() => expect(inFlight).toBeDefined())
      // The connection goes: every plugin that injected it goes with it.
      await fiber.dispose()
      await cancelled
      expect(inFlight?.aborted).toBe(true)
      expect(removeRestriction).toHaveBeenCalled()
      expect(await ctx.waterfall('tools/pre-execute', {} as never, async () => ({ kind: 'allow' }))).toEqual({
        kind: 'allow',
      })
      for (const key of ['oryhClient', 'oryhPane', 'oryhTodoDetails', 'oryhRecords', 'oryhChat'])
        expect(ctx.get(key as never), key).toBeUndefined()
      await expect(invoke('oryh', 'listConnections')).rejects.toThrow()
    } finally {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('serializes compile-time branded IDs as strings', () => {
    const method = (remote: typeof CONNECTION_REMOTE, name: string) =>
      remote.descriptors.find(item => item.method === name)!
    // A codec now hands out its schema through a `create()` factory rather than holding an instance.
    const verify = method(CONNECTION_REMOTE, 'verifyConnection').parameters[0]!.codec!.create()
    expect(verify.safeParse({ connectionId: 'connection-1' }).success).toBe(true)
    expect(verify.safeParse({ connectionId: 42 }).success).toBe(false)
  })
})
