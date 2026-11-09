import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OryhMcpClient, OryhMcpTool } from '@oryh/ai-client-core'
import { type ConnectionId, idempotentArguments, OryhClientError } from '@oryh/ai-client-foundation'
import { type Conversation, uploadedAttachments } from './attachments.js'

/** A name a server tool may take here: what the tool runtime accepts, and nothing that reads as a path. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** ORYH's tools that only read, for a server that does not mark them so itself. */
const READ_TOOLS = new Set([
  'oryh_list',
  'oryh_get',
  'oryh_detail',
  'builtin_object_types',
  'object_directory',
  'setup_report',
])

/**
 * Whether a call only reads. ORYH marks none of its tools read-only, so every read was taken for a write:
 * a question asked on a custom page opened the sales order the agent looked up, and each turn that only
 * read still told every page to re-read. The server's own hint counts wherever it is given.
 */
function readsOnly(tool: OryhMcpTool, args: unknown): boolean {
  if (tool.readOnly || READ_TOOLS.has(tool.name)) return true
  return tool.name === 'oryh_request' && isRecord(args) && String(args.method ?? '').toUpperCase() === 'GET'
}

/**
 * ORYH could not find an attachment a write cited. Its ids are long and the model copies them by hand: one
 * character off once read to it as "the upload never reached ORYH", and it asked the person to attach the
 * file again, which could not help. Shown the right id beside the wrong one, it still called them the same,
 * so the difference is spelt out: which id it cited, which upload that must have meant, and where they part.
 */
function withUploads(text: string, conversation: Conversation, args: unknown): string {
  if (!/attachment not found/i.test(text)) return text
  const uploaded = uploadedAttachments(conversation)
  if (!uploaded.length) return text
  const lines = [
    `本会话用 upload_attachment 上传过的附件：${uploaded.map(({ file, id }) => `${file} → ${id}`).join('；')}。`,
  ]
  const cited = new Set(
    JSON.stringify(args ?? {})
      .toLowerCase()
      .match(UUID) ?? [],
  )
  for (const id of cited) {
    if (uploaded.some(u => u.id.toLowerCase() === id)) continue
    for (const u of uploaded) {
      const differs = [...id].flatMap((c, i) => (c === u.id.toLowerCase()[i] ? [] : [i]))
      if (u.id.length !== id.length || differs.length > 4) continue
      const where = differs.map(i => `第 ${i + 1} 个字符是 ${id[i]}，应为 ${u.id[i]}`).join('；')
      lines.push(`这次引用的 ${id} 不是上传得到的编号，与 ${u.file} 的 ${u.id} 不同：${where}。请改用上传得到的编号。`)
    }
  }
  return `${text}\n${lines.join('\n')}`
}

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
  /** Each registered tool as the server described it, for telling a read from a write before it is made. */
  readonly #described = new Map<string, OryhMcpTool>()
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
    private readonly onRead: (sessionId: string, args: unknown, text: string, tool: string) => void = () => {},
  ) {}

  /** Names registered from the server, for the agent's allow-list. */
  get names(): ReadonlySet<string> {
    return new Set(this.#registered.keys())
  }

  /**
   * Whether a call to one of ORYH's tools would only read.
   * @param name - the tool called.
   * @param args - its arguments.
   * @returns undefined for a name that is not one of ORYH's tools.
   */
  reads(name: string, args: unknown): boolean | undefined {
    const tool = this.#described.get(name)
    return tool ? readsOnly(tool, isRecord(args) ? args : {}) : undefined
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
        this.#described.clear()
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
        this.#described.set(tool.name, tool)
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
        // A write carries the operation id as ORYH's idempotency key, so the same call sent twice writes
        // once, wherever this Host runs. The key is ours, not the model's: it replaces any argument of
        // that name. On the server the control process sets it again, over what arrived.
        const sent = isRecord(args) ? args : {}
        const read = readsOnly(tool, sent)
        const connection = await this.connectionOf(sessionId)
        // Finding the connection verifies it, which takes time: a call stopped meanwhile sends nothing, and
        // one already on its way is ended with the turn. What ORYH had already taken stays written — the
        // receipt and the idempotency key are how that is told apart, as before.
        exec.signal.throwIfAborted()
        const result = await mcp.callTool(
          connection,
          tool.name,
          read ? sent : idempotentArguments(sent, operation.operationId),
          { operation, signal: exec.signal },
        )
        // The server's answer is the outcome: an error is thrown so the model sees a failure, not a success.
        if (result.isError)
          throw new OryhClientError(withUploads(result.text, exec.agent.session, sent), 'request-failed')
        if (read) this.onRead(sessionId, args, result.text, tool.name)
        else this.onWrite(sessionId, args, result.text)
        return result.text
      },
    }
  }
}
