import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as plugin from '../src/index.js'
import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

describe('ORYH external Host plugin', () => {
  it('runs generated Remote through real Cordis and Gateway, then disposes the services', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'oryh-dsh-plugin-'))
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin(Gateway)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(Tools, {})
      ctx.provide('agents', { list: () => [], get: () => undefined } as never)
      ctx.get('typert').register(TYPERT)
      const fiber = ctx.plugin(plugin, { developmentOnly: true, dataDirectory })
      await fiber
      const removeRestriction = vi.fn()
      const restrict = vi.fn(() => removeRestriction)
      ctx.emit('agent/created', { agent: { id: 'agent', ctx: { tools: { restrict, presentAs: () => () => {} }, systemPrompt: { context: () => () => {} } } } } as never)
      expect(restrict).toHaveBeenCalledWith({ allow: ['skill', 'bash', 'oryh_skill_sync', 'oryh_record_filter_fields', 'oryh_menu_add', 'oryh_menu_remove', 'oryh_open_view', 'oryh_current_todo_details', 'oryh_timesheet_read', 'oryh_timesheet_propose', 'oryh_review_result', 'oryh_open_timesheet','oryh_find_timesheets','oryh_visible_todos','oryh_open_todo','oryh_current_page','oryh_project_columns','oryh_record_columns','oryh_record_query','oryh_search_products','oryh_navigate','oryh_open_project','oryh_project_read','oryh_project_fill'] })
      expect(await ctx.waterfall('tools/pre-execute', {} as never, async () => ({ kind: 'allow' }))).toMatchObject({ kind: 'deny' })
      const invoke = (method: string, args: Record<string, unknown> = {}) => ctx.get('typertGateway').invoke({ namespace: 'oryh', method, args })
      const previousOrigin = process.env.ORYH_SERVER_ORIGIN
      try {
        process.env.ORYH_SERVER_ORIGIN = 'https://oryh.example.test/'
        expect(await invoke('connectionDefaults')).toEqual({ origin: 'https://oryh.example.test' })
        process.env.ORYH_SERVER_ORIGIN = 'https://user:secret@example.com'
        await expect(invoke('connectionDefaults')).rejects.toThrow()
        delete process.env.ORYH_SERVER_ORIGIN
        expect(await invoke('connectionDefaults')).toEqual({ origin: '' })
      } finally {
        if (previousOrigin === undefined) delete process.env.ORYH_SERVER_ORIGIN
        else process.env.ORYH_SERVER_ORIGIN = previousOrigin
      }
      expect(await invoke('listConnections')).toEqual([])
      await expect(invoke('todoDetail', { request: { connectionId: 'unknown', todoId: 't' } })).rejects.toMatchObject({ code: 'oryh/business' })
      await expect(invoke('chatSelect', { request: { connectionId: 'unknown', sessionId: 42 } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
      expect(await invoke('listOperations')).toHaveLength(3)
      // The public generated Remote carries MCP results without pretending they are disk installs.
      const skillResult = { delivery: 'mcp' as const, skills: ['oryh-test'], message: 'Refreshed' }
      const refresh = vi.spyOn(ctx.get('oryhSkills'), 'sync').mockResolvedValue(skillResult)
      expect(await invoke('skillSync', { request: { connectionId: 'bound', force: true } })).toEqual(skillResult)
      expect(refresh).toHaveBeenCalledWith('bound', true)
      refresh.mockRestore()
      await expect(invoke('timesheetList', { request: { connectionId: 'unknown' } })).rejects.toMatchObject({ code: 'oryh/business', details: { code: 'connection-not-found' } })
      await expect(invoke('timesheetPrepare', { request: { connectionId: 'unknown', action: { kind: 'approve', decision: 'delete', comment: 'invalid' } } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
      await expect(invoke('timesheetConfirm', { request: { connectionId: 'unknown', id: 'i', revision: 1 } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
      await expect(invoke('expenseList', { request: { connectionId: 'unknown' } })).rejects.toMatchObject({ code: 'oryh/business', details: { code: 'connection-not-found' } })
      await expect(invoke('expenseList', { request: { connectionId: 17 } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
      await expect(invoke('listConnections', { extra: 'not accepted' })).rejects.toThrow()
      let inFlight: AbortSignal | undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => new Promise((_resolve, reject) => {
        inFlight = init?.signal ?? undefined
        inFlight?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      }))
      const cancelled = expect(invoke('beginConnection', { request: { origin: 'http://localhost:8080', clientName: 'test' } })).rejects.toMatchObject({ code: 'oryh/business' })
      await vi.waitFor(() => expect(inFlight).toBeDefined())
      await fiber.dispose()
      await cancelled
      expect(inFlight?.aborted).toBe(true)
      expect(removeRestriction).toHaveBeenCalled()
      expect(await ctx.waterfall('tools/pre-execute', {} as never, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
      expect(ctx.get('oryhClient')).toBeUndefined()
      expect(ctx.get('oryhExpenses')).toBeUndefined()
      expect(ctx.get('oryhTimesheets')).toBeUndefined()
      expect(ctx.get('oryhChat')).toBeUndefined()
      expect(ctx.get('oryhTodoDetails')).toBeUndefined()
      await expect(invoke('listConnections')).rejects.toThrow()
    } finally { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(dataDirectory, { recursive: true, force: true }) }
  })

  it('serializes compile-time branded IDs as strings, and preserves strict confirmation types', () => {
    const method = (name: string) => TYPERT_REMOTE.descriptors.find(item => item.method === name)!
    expect(method('verifyConnection').parameters[0]!.codec!.schema.safeParse({ connectionId: 'connection-1' }).success).toBe(true)
    expect(method('verifyConnection').parameters[0]!.codec!.schema.safeParse({ connectionId: 42 }).success).toBe(false)
    expect(method('expenseConfirm').parameters[0]!.codec!.schema.safeParse({ connectionId: 'c', id: 'd', revision: 1 }).success).toBe(false)
  })

  it('rejects relative persistence paths and unvalidated production composition', async () => {
    const ctx = new Context()
    await expect(plugin.apply(ctx, { developmentOnly: true, dataDirectory: './data' })).rejects.toThrow(/absolute path/)
    await expect(plugin.apply(ctx, { developmentOnly: false })).rejects.toThrow(/developmentOnly/)
    // Server mode takes its identity only from the control process that started it.
    await expect(plugin.apply(ctx, { developmentOnly: false, mode: 'server' })).rejects.toThrow(/control process/)
  })
})
