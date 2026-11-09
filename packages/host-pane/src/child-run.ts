/**
 * What a plugin needs to see a run through in a session of its own, under the Chat it works for.
 *
 * Harness's subagent service starts such a run through a provider the plugin registers; the provider
 * creates the child session and drives it. These are the parts of that every provider here writes the
 * same way: the descriptor Harness reads a child by, and how a run's end is told to its observers.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  SUBAGENT_DESCRIPTOR_VERSION,
  type SubagentDescriptorData,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

/**
 * Record what a run is in its own log, inside its first turn: Harness lists a Chat's children by this.
 * @param child - the run's own context.
 * @param descriptor - as the subagent service resolved it for this start.
 */
export function describeRun(child: Context, descriptor: SubagentDescriptorData): void {
  let described = false
  child.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!described && decision.kind === 'enter') {
      described = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/** Record a local one-shot child through public Session events; caller delivery adds no parent notification. */
export function catalogRun(parent: Agent, agent: Agent, label?: string): void {
  parent.session.append('subagent/catalog', {
    version: 0,
    childId: agent.id,
    childCreatedAt: agent.session.header.createdAt,
    mode: 'one-shot',
    ...(label ? { label } : {}),
  })
}

/** The descriptor of a provider-owned, non-resumable local run. */
export function oneShotDescriptor(provider: string, label?: string): SubagentDescriptorData {
  return { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider, ...(label ? { label } : {}) }
}

/** How a session's last turn ended, as Harness recorded it; undefined when none has. */
export function lastTurnEnd(session: { ownEvents(): readonly { type: string; data?: unknown }[] }): unknown {
  const events = session.ownEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type !== 'turn/end') continue
    return (event.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
  }
  return undefined
}

/** A run's end in the words Harness's subagent observers read; a run that was stopped says so. */
export function stopReasonOf(end: unknown, stopped: boolean): SubagentStopReason {
  if (end === 'completed') return 'completed'
  if (stopped) return 'aborted'
  switch (end) {
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // A step refused before it began: the task was declined, not done.
    case 'blocked':
      return 'refusal'
    default:
      return 'error'
  }
}

/** The last thing a run's model wrote, shortened, so what stopped it can be said where it was asked for. */
export function lastAssistantText(messages: readonly { role: string; content: unknown }[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const text = (message.content as { type?: unknown; text?: unknown }[])
      .map(part => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
    if (text) return text.length > 300 ? `${text.slice(0, 300)}…` : text
  }
  return undefined
}
