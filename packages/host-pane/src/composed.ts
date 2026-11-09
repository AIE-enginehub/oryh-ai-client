/**
 * Messages the Host writes in a person's place.
 *
 * A question asked from a page, a form handed over, a review requested, a page's run started: each goes
 * to the agent as a user message, because that is what makes the agent take a turn, and each has words in
 * it the person did not type. The session's record should be able to tell the two apart, so the source
 * says who composed it and for what — as Harness's own prompts carry their request id on a source whose
 * kind is still `user`. The kind is kept so that the conversation shows the message as the person's turn,
 * which it stands for.
 */
import type {} from '@deepseek-ai/dsh-llm'

/** What a Host-composed message stands for. */
export type OryhComposed =
  /** Asked from a page: the person's question, with where it was asked appended. */
  | { readonly by: 'page-question' }
  /** A form on a custom page, confirmed there and handed over. */
  | { readonly by: 'page-form' }
  /** A form filled in the conversation; `formCallId` is the tool call that showed it. */
  | { readonly by: 'chat-form'; readonly formCallId: string }
  /** A check before submitting, asked of the Chat or of a session of its own. */
  | { readonly by: 'review' }
  /** The task of a custom page's run, or its nudge to go on. */
  | { readonly by: 'page-run' }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Written by an ORYH Host plugin on the person's behalf; `oryh` says for what. */
    'oryh-composed': { kind: 'user'; oryh: OryhComposed }
  }
}

/**
 * The source of a message the Host composed.
 * @param oryh - what it stands for.
 */
export function composed(oryh: OryhComposed): { kind: 'user'; oryh: OryhComposed } {
  return { kind: 'user', oryh }
}
