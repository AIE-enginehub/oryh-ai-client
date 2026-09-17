/**
 * The ORYH business agent as a Harness Host plugin: what the Chat session is told, which tools it may
 * use, ORYH's own MCP tools, and the pane following what it reads and writes. It composes nothing
 * itself: the pages it steers reached the pane before it loaded.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@oryh/dsh-connection'
import type {} from '@oryh/dsh-pane'
import { BusinessAgent } from './business-agent.js'

export { BusinessAgent, type BusinessAgentOptions } from './business-agent.js'
export { OryhMcpTools } from './mcp-tools.js'
export { instructions, RULES } from './prompts.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhChat: BusinessAgent
  }
}

export const name = 'oryh-agent'
export const inject = [
  'tools',
  'agents',
  'systemPrompt',
  'oryhClient',
  'oryhHost',
  'oryhPane',
  'oryhSkills',
  'oryhMcp',
  'oryhData',
]

export function apply(ctx: Context): void {
  const agent = new BusinessAgent(ctx, {
    controller: ctx.oryhClient,
    host: ctx.oryhHost,
    pane: ctx.oryhPane,
    skills: ctx.oryhSkills,
    mcp: ctx.oryhMcp,
    capabilities: ctx.oryhData.capabilities,
  })
  ctx.provide('oryhChat', agent)
  agent.install()
}
