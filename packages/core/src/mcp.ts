import { OryhClientError } from '@oryh/ai-client-foundation'
import type { ConnectionId } from './brand.js'
import type { OryhHttpClient } from './http.js'
import type { OryhOperation } from './server-operation.js'

/**
 * ORYH's MCP endpoint, spoken by the Host on the agent's behalf.
 *
 * ORYH delivers the same skills two ways. A downloaded bundle renders the person's API key into the
 * text and ships scripts that send it; over MCP the connection carries the credential, every API call
 * is a tool, and the text is rendered for that delivery with no key in it. The bundle's key went into
 * the model with every skill load, so this client takes MCP (ADR-0012).
 *
 * It speaks the protocol itself rather than through Harness's MCP bridge, for three reasons: the
 * credential is the connection's own and rotates inside `OryhHttpClient`, which a static header in a
 * profile cannot follow; a session's calls must go to that session's enterprise; and the skills arrive
 * as MCP prompts and resources, which the bridge does not carry.
 *
 * ORYH's endpoint is stateless Streamable HTTP: one POST per exchange, JSON-RPC in and out, batches
 * allowed, no session and no server-initiated stream.
 */

/** A tool as the server lists it. */
export interface OryhMcpTool {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments, as the server declares it. */
  readonly inputSchema: Record<string, unknown>
  /** MCP's `readOnlyHint`: a call to such a tool cannot have changed anything. */
  readonly readOnly: boolean
}

/** A prompt as the server lists it; for ORYH, one skill under its registry name. */
export interface OryhMcpPrompt {
  readonly name: string
  readonly description: string
}

/** What a tool call answered, and whether the server called it an error. */
export interface OryhMcpToolResult {
  readonly text: string
  readonly isError: boolean
}

interface RpcRequest {
  readonly method: string
  readonly params?: Record<string, unknown>
}

type Json = Record<string, unknown>

/** Largest JSON-RPC batch sent in one POST; a tenant's skills take a handful. */
const BATCH_SIZE = 20

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The text blocks of an MCP content array, joined; other block types are named rather than dropped. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block =>
      isObject(block)
        ? block.type === 'text' && typeof block.text === 'string'
          ? block.text
          : `[${String(block.type)}]`
        : '',
    )
    .join('\n')
}

export class OryhMcpClient {
  #nextId = 0

  /** @param http - authenticated ORYH transport; the credential never leaves it. */
  constructor(private readonly http: OryhHttpClient) {}

  /**
   * Tools this credential may call.
   * @param connectionId - the enterprise connection to ask.
   */
  async tools(connectionId: ConnectionId): Promise<OryhMcpTool[]> {
    const rows = await this.pages(connectionId, 'tools/list', 'tools')
    return rows.flatMap(row => {
      if (!isObject(row) || typeof row.name !== 'string') return []
      const annotations = isObject(row.annotations) ? row.annotations : {}
      return [
        {
          name: row.name,
          description: typeof row.description === 'string' ? row.description : '',
          inputSchema: isObject(row.inputSchema) ? row.inputSchema : { type: 'object', properties: {} },
          readOnly: annotations.readOnlyHint === true,
        },
      ]
    })
  }

  /**
   * Call one tool.
   * @param connectionId - the enterprise connection whose credential the call carries.
   * @param name - the tool's name as the server lists it.
   * @param args - the tool's arguments.
   * @param options - `operation`: on the server, the chat write this call is, for the control process to admit and record.
   * @returns the answered text; `isError` when the server reports the call failed.
   */
  async callTool(
    connectionId: ConnectionId,
    name: string,
    args: Json,
    options: { readonly operation?: OryhOperation } = {},
  ): Promise<OryhMcpToolResult> {
    const [result] = await this.exchange(
      connectionId,
      [{ method: 'tools/call', params: { name, arguments: args } }],
      options.operation,
    )
    const reply = isObject(result) ? result : {}
    const text =
      textOf(reply.content) ||
      (reply.structuredContent === undefined ? '（没有返回内容）' : JSON.stringify(reply.structuredContent))
    return { text, isError: reply.isError === true }
  }

  /**
   * Prompts this credential may read — for ORYH, the skills its role is entitled to.
   * @param connectionId - the enterprise connection to ask.
   */
  async prompts(connectionId: ConnectionId): Promise<OryhMcpPrompt[]> {
    const rows = await this.pages(connectionId, 'prompts/list', 'prompts')
    return rows.flatMap(row =>
      isObject(row) && typeof row.name === 'string'
        ? [{ name: row.name, description: typeof row.description === 'string' ? row.description : '' }]
        : [],
    )
  }

  /**
   * Each named prompt's text: for ORYH, a skill's SKILL.md as the MCP delivery reads it.
   * @param connectionId - the enterprise connection to ask.
   * @param names - prompt names, from `prompts`.
   * @returns text by prompt name; a prompt the server answered without text is absent.
   */
  async promptTexts(connectionId: ConnectionId, names: readonly string[]): Promise<Map<string, string>> {
    const replies = await this.exchange(
      connectionId,
      names.map(name => ({ method: 'prompts/get', params: { name } })),
    )
    const texts = new Map<string, string>()
    replies.forEach((reply, index) => {
      const messages = isObject(reply) && Array.isArray(reply.messages) ? reply.messages : []
      const text = messages
        .map(message =>
          isObject(message) && isObject(message.content) && typeof message.content.text === 'string'
            ? message.content.text
            : '',
        )
        .join('\n')
      if (text) texts.set(names[index]!, text)
    })
    return texts
  }

  /**
   * Resource URIs this credential may read.
   * @param connectionId - the enterprise connection to ask.
   */
  async resources(connectionId: ConnectionId): Promise<string[]> {
    const rows = await this.pages(connectionId, 'resources/list', 'resources')
    return rows.flatMap(row => (isObject(row) && typeof row.uri === 'string' ? [row.uri] : []))
  }

  /**
   * Each resource's text.
   * @param connectionId - the enterprise connection to ask.
   * @param uris - resource URIs, from `resources`.
   * @returns text by URI; a resource the server answered without text is absent.
   */
  async resourceTexts(connectionId: ConnectionId, uris: readonly string[]): Promise<Map<string, string>> {
    const replies = await this.exchange(
      connectionId,
      uris.map(uri => ({ method: 'resources/read', params: { uri } })),
    )
    const texts = new Map<string, string>()
    replies.forEach((reply, index) => {
      const contents = isObject(reply) && Array.isArray(reply.contents) ? reply.contents : []
      const text = contents
        .map(content => (isObject(content) && typeof content.text === 'string' ? content.text : ''))
        .join('')
      if (text) texts.set(uris[index]!, text)
    })
    return texts
  }

  /** Every row of a paginated list, refusing a server that repeats its cursor. */
  private async pages(connectionId: ConnectionId, method: string, key: string): Promise<unknown[]> {
    const rows: unknown[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const [result] = await this.exchange(connectionId, [
        { method, ...(cursor === undefined ? {} : { params: { cursor } }) },
      ])
      const page = isObject(result) ? result : {}
      if (Array.isArray(page[key])) rows.push(...page[key])
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new OryhClientError(`ORYH MCP 的 ${method} 重复了分页游标。`, 'invalid-response')
        seen.add(cursor)
      }
    } while (cursor !== undefined)
    return rows
  }

  /**
   * One or more JSON-RPC requests, batched, answered in request order.
   * @param connectionId - the enterprise connection whose credential the exchange carries.
   * @param requests - requests to send.
   * @returns each request's `result`.
   */
  private async exchange(
    connectionId: ConnectionId,
    requests: readonly RpcRequest[],
    operation?: OryhOperation,
  ): Promise<unknown[]> {
    const results: unknown[] = []
    for (let start = 0; start < requests.length; start += BATCH_SIZE) {
      const chunk = requests.slice(start, start + BATCH_SIZE)
      const messages = chunk.map(request => ({
        jsonrpc: '2.0',
        id: ++this.#nextId,
        method: request.method,
        ...(request.params === undefined ? {} : { params: request.params }),
      }))
      const body = await this.http.request(connectionId, {
        path: '/mcp',
        root: true,
        method: 'POST',
        body: messages.length === 1 ? messages[0] : messages,
        ...(operation ? { operation } : {}),
      })
      const replies = new Map((Array.isArray(body) ? body : [body]).filter(isObject).map(reply => [reply.id, reply]))
      messages.forEach((message, index) => {
        const reply = replies.get(message.id)
        if (reply === undefined)
          throw new OryhClientError(`ORYH MCP 没有回应 ${chunk[index]!.method}。`, 'invalid-response')
        if (isObject(reply.error))
          throw new OryhClientError(
            `ORYH MCP ${chunk[index]!.method} 失败：${String(reply.error.message ?? '')}`,
            'request-failed',
          )
        results.push(reply.result)
      })
    }
    return results
  }
}
