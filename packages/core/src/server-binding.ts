import type { OryhIdentity } from './contracts.js'
import type { DelegatedResponse, OryhRequest } from './http.js'

/**
 * A business Host's link to the trusted server process that holds its person's ORYH grant.
 * Bound by trusted server code, never serializable plugin config or a browser Remote argument.
 */
export interface ServerBinding {
  readonly origin: string
  readonly identity: OryhIdentity
  readonly signal: AbortSignal
  /** Send one ORYH request under that grant; the server process decides what it lets through. */
  send(request: OryhRequest, signal: AbortSignal): Promise<DelegatedResponse>
  /** Whether this Host may install skills read over MCP into its own skills directory. */
  readonly installSkills?: boolean
}
