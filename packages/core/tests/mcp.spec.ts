import { describe, expect, it, vi } from 'vitest'
import type { ConnectionId } from '../src/brand.js'
import { OryhMcpClient } from '../src/mcp.js'

const connectionId = 'c' as ConnectionId
type Message = { jsonrpc: string; id: number; method: string; params?: Record<string, unknown> }

/** An MCP endpoint answering each message with `respond`, recording every POST it receives. */
function endpoint(respond: (message: Message) => unknown) {
  const posts: unknown[] = []
  const requests: unknown[] = []
  const request = vi.fn(
    async (_id: ConnectionId, r: { path: string; root?: boolean; method?: string; body?: unknown }) => {
      expect(r).toMatchObject({ path: '/mcp', root: true, method: 'POST' })
      posts.push(r.body)
      requests.push(r)
      const reply = (message: Message) => ({ jsonrpc: '2.0', id: message.id, ...(respond(message) as object) })
      return Array.isArray(r.body) ? (r.body as Message[]).map(reply) : reply(r.body as Message)
    },
  )
  return { posts, requests, client: new OryhMcpClient({ request } as never) }
}

describe('ORYH MCP client', () => {
  it("lists tools across pages and reads MCP's read-only hint", async () => {
    const { client } = endpoint(message =>
      message.params?.cursor === undefined
        ? {
            result: {
              tools: [{ name: 'oryh_request', description: 'call', inputSchema: { type: 'object', properties: {} } }],
              nextCursor: 'p2',
            },
          }
        : { result: { tools: [{ name: 'oryh_get', annotations: { readOnlyHint: true } }] } },
    )
    expect(await client.tools(connectionId)).toEqual([
      { name: 'oryh_request', description: 'call', inputSchema: { type: 'object', properties: {} }, readOnly: false },
      { name: 'oryh_get', description: '', inputSchema: { type: 'object', properties: {} }, readOnly: true },
    ])
  })

  it('refuses a server that repeats its paging cursor instead of looping', async () => {
    const { client } = endpoint(() => ({ result: { tools: [], nextCursor: 'again' } }))
    await expect(client.tools(connectionId)).rejects.toThrow(/分页游标/)
  })

  it("returns a tool's text and says when the server called it an error", async () => {
    const { client } = endpoint(message =>
      (message.params as { arguments: { path: string } }).arguments.path === '/missing'
        ? { result: { isError: true, content: [{ type: 'text', text: '{"detail":"not found"}' }] } }
        : { result: { content: [{ type: 'text', text: '{"data":[]}' }] } },
    )
    expect(await client.callTool(connectionId, 'oryh_request', { method: 'GET', path: '/todos' })).toEqual({
      text: '{"data":[]}',
      isError: false,
    })
    expect(await client.callTool(connectionId, 'oryh_request', { method: 'GET', path: '/missing' })).toEqual({
      text: '{"detail":"not found"}',
      isError: true,
    })
  })

  it("carries a chat write's operation on the request, for the server to admit and record", async () => {
    const { client, requests } = endpoint(() => ({ result: { content: [{ type: 'text', text: '{}' }] } }))
    const operation = { kind: 'chat' as const, operationId: 'op-1', sessionId: 's', callId: 'call-1' }
    await client.callTool(connectionId, 'oryh_request', { method: 'POST', path: '/projects' }, { operation })
    await client.callTool(connectionId, 'oryh_request', { method: 'GET', path: '/projects' })
    expect(requests[0]).toMatchObject({ operation })
    expect(requests[1]).not.toHaveProperty('operation')
  })

  it('batches prompt reads, and fails loudly on a JSON-RPC error rather than returning part of the set', async () => {
    const names = Array.from({ length: 25 }, (_, index) => `skill-${index}`)
    const { client, posts } = endpoint(message => ({
      result: {
        messages: [{ role: 'user', content: { type: 'text', text: `body of ${String(message.params?.name)}` } }],
      },
    }))
    const texts = await client.promptTexts(connectionId, names)
    expect(texts.get('skill-24')).toBe('body of skill-24')
    // Twenty-five reads in two POSTs, not twenty-five.
    expect(posts).toHaveLength(2)

    const failing = endpoint(message =>
      message.params?.name === 'skill-3'
        ? { error: { code: -32602, message: 'no skill reaches this credential' } }
        : { result: { messages: [] } },
    )
    await expect(failing.client.promptTexts(connectionId, names.slice(0, 5))).rejects.toThrow(
      /no skill reaches this credential/,
    )
  })
})
