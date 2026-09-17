import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OryhMcpClient, OryhMcpTool } from '@oryh/ai-client-core'
import { type ConnectionId, OryhClientError } from '@oryh/ai-client-foundation'

/** A name a server tool may take here: what the tool runtime accepts, and nothing that reads as a path. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * ORYH's MCP tools, offered to the agent as its own (ADR-0012).
 *
 * The skills this client installs are rendered for MCP delivery: they carry no key, and they say every
 * API call is a tool call. These are those tools. The Host lists them from the server rather than
 * naming them in code, registers each once, and runs each call over the calling session's enterprise
 * connection, so the credential never leaves the Host and keeps rotating there.
 *
 * A call to a tool the server does not mark read-only may have written to ORYH; the owner is told, so
 * the business pane re-reads what it shows when the turn ends. A read is reported too, so the pane can
 * follow what the agent is looking at.
 */
export class OryhMcpTools {
  readonly #registered = new Map<string, () => void>()
  readonly #listed = new Set<ConnectionId>()
  readonly #listeners = new Set<() => void>()
  #queue: Promise<void> = Promise.resolve()

  /**
   * @param ctx - where the tools are registered.
   * @param mcp - ORYH's MCP endpoint; without it no tools are offered.
   * @param connectionOf - the enterprise connection a session's calls go to.
   * @param reserved - names the Host already uses for its own tools, which a server tool may not take.
   * @param onWrite - told of each session whose call may have written to ORYH.
   */
  constructor(
    private readonly ctx: Context,
    private readonly mcp: OryhMcpClient | undefined,
    private readonly connectionOf: (sessionId: string) => Promise<ConnectionId>,
    private readonly reserved: () => readonly string[],
    private readonly onWrite: (sessionId: string, args: unknown, text: string) => void,
    /** Told of each read, so the business pane can show what the agent is reading. */
    private readonly onRead: (sessionId: string, args: unknown, text: string) => void = () => {},
  ) {}

  /** Names registered from the server, for the agent's allow-list. */
  get names(): ReadonlySet<string> {
    return new Set(this.#registered.keys())
  }

  /**
   * Be told when the registered names change.
   * @param listener - called after tools are added.
   * @returns a function that stops listening.
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Unregister everything when the plugin goes away. */
  install(): void {
    this.ctx.effect(
      () => () => {
        for (const dispose of this.#registered.values()) dispose()
        this.#registered.clear()
        this.#listed.clear()
      },
      'oryh mcp tools',
    )
  }

  /**
   * Register the tools a connection's server lists, once per name.
   *
   * A connection is asked once; a failed listing is not remembered, so the next binding asks again.
   * A name the Host already uses for its own tool is skipped rather than shadowed.
   * @param connectionId - a connection to list tools through.
   * @returns when this listing has been applied.
   */
  refresh(connectionId: ConnectionId): Promise<void> {
    const run = this.#queue.then(() => this.load(connectionId))
    this.#queue = run.catch(() => {})
    return run
  }

  private async load(connectionId: ConnectionId): Promise<void> {
    if (this.mcp === undefined || this.#listed.has(connectionId)) return
    const tools = await this.mcp.tools(connectionId)
    this.#listed.add(connectionId)
    let added = false
    for (const tool of tools) {
      if (this.#registered.has(tool.name) || this.reserved().includes(tool.name) || !TOOL_NAME.test(tool.name)) continue
      try {
        this.#registered.set(tool.name, this.ctx.tools.register(this.definition(tool)))
        added = true
      } catch (error) {
        // Another plugin owns the name, or the schema is outside what the runtime accepts: the rest still register.
        this.ctx.logger?.warn?.(
          `ORYH MCP tool ${tool.name} was not registered: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (added) for (const listener of this.#listeners) listener()
  }

  private definition(tool: OryhMcpTool): ToolDefinition {
    const mcp = this.mcp!
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async (args, exec) => {
        if (!exec.agent) throw new OryhClientError('需要会话。', 'request-failed')
        exec.signal.throwIfAborted()
        const sessionId = String(exec.agent.id)
        // Each call names itself as a chat write. The server's control process admits and records a write
        // once under this id and ignores it on a read; the desktop transport ignores it altogether.
        const operation = { kind: 'chat' as const, operationId: randomUUID(), sessionId, callId: String(exec.callId) }
        const result = await mcp.callTool(await this.connectionOf(sessionId), tool.name, isRecord(args) ? args : {}, {
          operation,
        })
        // The server's answer is the outcome: an error is thrown so the model sees a failure, not a success.
        if (result.isError) throw new OryhClientError(result.text, 'request-failed')
        if (tool.readOnly) this.onRead(sessionId, args, result.text)
        else this.onWrite(sessionId, args, result.text)
        return result.text
      },
    }
  }
}
