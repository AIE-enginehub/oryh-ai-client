import { describe, expect, it, vi } from 'vitest'
import { OryhMcpTools } from '../src/mcp-tools.js'

type Definition = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

/** ORYH's tools registered against a stand-in MCP endpoint, with the connection lookup ours to hold back. */
async function setup() {
  const registered: Definition[] = []
  const ctx = { tools: { register: (definition: Definition) => (registered.push(definition), () => {}) } }
  const callTool = vi.fn(async () => ({ text: '{"data":{"id":"p1"}}', isError: false }))
  const mcp = {
    tools: async () => [{ name: 'oryh_request', description: '', inputSchema: { type: 'object' }, readOnly: false }],
    callTool,
  }
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const tools = new OryhMcpTools(
    ctx as never,
    mcp as never,
    async () => {
      await held
      return 'c' as never
    },
    () => [],
    () => {},
  )
  await tools.refresh('c' as never)
  const exec = (signal: AbortSignal) => ({ agent: { id: 's', session: {} }, signal, callId: 'call-1' })
  return { tool: registered[0]!, callTool, release, exec }
}

describe("ORYH's tools and a stopped turn", () => {
  it('sends nothing for a call stopped while its connection was being found', async () => {
    const f = await setup()
    const stop = new AbortController()
    const running = f.tool.execute({ method: 'POST', path: '/projects', body: {} }, f.exec(stop.signal))
    // The person presses stop while the connection is still being verified; then it verifies.
    stop.abort()
    f.release()
    await expect(running).rejects.toThrow()
    expect(f.callTool).not.toHaveBeenCalled()
  })

  it("hands the call's own cancellation to the request, so one already sent ends with the turn", async () => {
    const f = await setup()
    const stop = new AbortController()
    f.release()
    await f.tool.execute({ method: 'POST', path: '/projects', body: {} }, f.exec(stop.signal))
    expect(f.callTool).toHaveBeenCalledTimes(1)
    expect((f.callTool.mock.calls[0] as unknown[])[3]).toMatchObject({ signal: stop.signal })
  })
})
