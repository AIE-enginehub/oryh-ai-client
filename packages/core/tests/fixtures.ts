import type { Fetcher, FetchResponse } from '../src/http.js'

/** Create a minimal JSON fetch response for core tests. */
export function jsonResponse(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json(): Promise<unknown> {
      return body
    },
  }
}

/** A scripted Host fetcher that records requests without performing network I/O. */
export class ScriptedFetcher {
  readonly calls: Array<{ readonly input: string; readonly init: RequestInit | undefined }> = []

  constructor(private readonly responses: FetchResponse[]) {}

  readonly fetch: Fetcher = async (input, init) => {
    this.calls.push({ input, init })
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`Unexpected request: ${input}`)
    return response
  }
}

/** Retrieve a named request header from a captured RequestInit. */
export function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (headers === undefined || Array.isArray(headers)) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  return headers[name]
}
