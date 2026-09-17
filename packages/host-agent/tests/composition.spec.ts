import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as connection from '@oryh/dsh-connection'
import { TYPERT_REMOTE as CONNECTION_REMOTE } from '@oryh/dsh-connection/remote'
import { TYPERT as CONNECTION } from '@oryh/dsh-connection/typert'
import * as expenses from '@oryh/dsh-expenses'
import { TYPERT_REMOTE as EXPENSES_REMOTE } from '@oryh/dsh-expenses/remote'
import { TYPERT as EXPENSES } from '@oryh/dsh-expenses/typert'
import * as pane from '@oryh/dsh-pane'
import { TYPERT as PANE } from '@oryh/dsh-pane/typert'
import * as projects from '@oryh/dsh-projects'
import { TYPERT as PROJECTS } from '@oryh/dsh-projects/typert'
import * as records from '@oryh/dsh-records'
import { TYPERT as RECORDS } from '@oryh/dsh-records/typert'
import * as timesheets from '@oryh/dsh-timesheets'
import { TYPERT as TIMESHEETS } from '@oryh/dsh-timesheets/typert'
import * as todos from '@oryh/dsh-todos'
import { TYPERT as TODOS } from '@oryh/dsh-todos/typert'
import { describe, expect, it, vi } from 'vitest'
import * as agent from '../src/index.js'

/** The bundle's Host side, in the order `cordis.patch.yml` loads it. */
const PLUGINS = [pane, todos, timesheets, expenses, projects, records, agent]
const TYPERTS = [CONNECTION, PANE, TODOS, TIMESHEETS, EXPENSES, PROJECTS, RECORDS]

describe('the ORYH Host plugins composed', () => {
  it('run their generated Remotes through real Cordis and Gateway, and go down with the connection', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'oryh-dsh-plugins-'))
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin(Gateway)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(Tools, {})
      ctx.provide('agents', { list: () => [], get: () => undefined } as never)
      for (const typert of TYPERTS) ctx.get('typert').register(typert)
      const fiber = ctx.plugin(connection, { developmentOnly: true, dataDirectory })
      await fiber
      for (const plugin of PLUGINS) await ctx.plugin(plugin)
      const removeRestriction = vi.fn()
      const restrict = vi.fn(() => removeRestriction)
      ctx.emit('agent/created', {
        agent: {
          id: 'agent',
          ctx: { tools: { restrict, presentAs: () => () => {} }, systemPrompt: { context: () => () => {} } },
        },
      } as never)
      // The allow-list is the pages' contributions, not a list kept in the agent.
      const allowed = (restrict.mock.calls.at(-1)![0] as { allow: string[] }).allow
      expect([...allowed].sort()).toEqual(
        [
          'skill',
          'bash',
          'oryh_skill_sync',
          ...pane.PANE_TOOLS,
          'oryh_review_result',
          ...todos.TODO_TOOLS,
          ...timesheets.TIMESHEET_TOOLS,
          ...projects.PROJECT_TOOLS,
          ...records.RECORD_TOOLS,
        ].sort(),
      )
      expect(await ctx.waterfall('tools/pre-execute', {} as never, async () => ({ kind: 'allow' }))).toMatchObject({
        kind: 'deny',
      })
      const invoke = (namespace: string, method: string, args: Record<string, unknown> = {}) =>
        ctx.get('typertGateway').invoke({ namespace, method, args })
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
      expect(await invoke('oryh', 'listOperations')).toHaveLength(3)
      // The public generated Remote carries MCP results without pretending they are disk installs.
      const skillResult = { delivery: 'mcp' as const, skills: ['oryh-test'], message: 'Refreshed' }
      const refresh = vi.spyOn(ctx.get('oryhSkills'), 'sync').mockResolvedValue(skillResult)
      expect(await invoke('oryh', 'skillSync', { request: { connectionId: 'bound', force: true } })).toEqual(
        skillResult,
      )
      expect(refresh).toHaveBeenCalledWith('bound', true)
      refresh.mockRestore()
      await expect(
        invoke('oryhTimesheets', 'timesheetList', { request: { connectionId: 'unknown' } }),
      ).rejects.toMatchObject({ code: 'oryh/business', details: { code: 'connection-not-found' } })
      await expect(
        invoke('oryhTimesheets', 'timesheetPrepare', {
          request: { connectionId: 'unknown', action: { kind: 'approve', decision: 'delete', comment: 'invalid' } },
        }),
      ).rejects.toMatchObject({ code: 'gateway/input-invalid' })
      await expect(
        invoke('oryhTimesheets', 'timesheetConfirm', { request: { connectionId: 'unknown', id: 'i', revision: 1 } }),
      ).rejects.toMatchObject({ code: 'gateway/input-invalid' })
      await expect(
        invoke('oryhExpenses', 'expenseList', { request: { connectionId: 'unknown' } }),
      ).rejects.toMatchObject({
        code: 'oryh/business',
        details: { code: 'connection-not-found' },
      })
      await expect(invoke('oryhExpenses', 'expenseList', { request: { connectionId: 17 } })).rejects.toMatchObject({
        code: 'gateway/input-invalid',
      })
      await expect(invoke('oryhProjects', 'projectOptions', { r: { connectionId: 'unknown' } })).rejects.toMatchObject({
        code: 'oryh/business',
      })
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
      for (const key of [
        'oryhClient',
        'oryhPane',
        'oryhTodoDetails',
        'oryhTimesheets',
        'oryhExpenses',
        'oryhProjects',
        'oryhRecords',
        'oryhChat',
      ])
        expect(ctx.get(key as never), key).toBeUndefined()
      await expect(invoke('oryh', 'listConnections')).rejects.toThrow()
    } finally {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('serializes compile-time branded IDs as strings, and preserves strict confirmation types', () => {
    const method = (remote: typeof CONNECTION_REMOTE, name: string) =>
      remote.descriptors.find(item => item.method === name)!
    const verify = method(CONNECTION_REMOTE, 'verifyConnection').parameters[0]!.codec!.schema
    expect(verify.safeParse({ connectionId: 'connection-1' }).success).toBe(true)
    expect(verify.safeParse({ connectionId: 42 }).success).toBe(false)
    const confirm = method(EXPENSES_REMOTE, 'expenseConfirm').parameters[0]!.codec!.schema
    expect(confirm.safeParse({ connectionId: 'c', id: 'd', revision: 1 }).success).toBe(false)
    expect(confirm.safeParse({ connectionId: 'c', id: 'd', revision: 1, token: 't' }).success).toBe(true)
  })
})
