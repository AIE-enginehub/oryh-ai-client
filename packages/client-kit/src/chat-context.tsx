/**
 * What a page knows of Chat itself, and may do to it: the frame hands these to a page, in its `frame` prop.
 * No interface library here, so the workbench can show the agent's activity without bringing one in.
 */
import type { ReactNode } from 'react'
import type { OryhText } from './locale.js'

/** What the frame lets a page do to Chat itself, beyond the pane bridge. */
export interface ChatActions {
  /** Open a new session in Chat; false where the workspace is not there to open one in. */
  startSession(): boolean
  /** Bring Chat forward: on a narrow screen, or when it is hidden. */
  showChat(): void
  /** Show another conversation in Chat and bring Chat forward: the one that is waiting on the person. */
  showSession(sessionId: string): void
}
/** What the agent of the pane's session is doing, as a page needs to know it. */
export type ChatActivity = 'none' | 'running' | 'waiting' | 'idle'
/**
 * The conversation that waits on the person while another is on show.
 * @param statuses - each session's status, as Harness lists them.
 * @param shown - the conversations on show: the Chat the pane is bound to and whatever the main view holds.
 * @returns the first such session's id, or undefined when none waits or the one that waits is on show.
 */
export function waitingElsewhere(
  statuses: Iterable<readonly [unknown, { pendingInteraction?: unknown } | undefined]>,
  shown: readonly (string | undefined)[],
): string | undefined {
  for (const [id, status] of statuses)
    if (status?.pendingInteraction !== undefined && !shown.includes(String(id))) return String(id)
  return undefined
}

/**
 * A word, above every page, on what the agent is doing in the session the page is bound to.
 *
 * A page could change under the person's eyes — a record opened, a form filled, a list re-read — with
 * nothing on it to say the agent was at work, or that it had stopped to wait for them. Shown only while
 * there is something to say; the one that waits on the person takes them to Chat.
 */
export function ChatActivityNote({
  t,
  activity,
  chat,
  elsewhere,
}: {
  t: OryhText
  activity: ChatActivity
  chat: ChatActions
  /**
   * A conversation other than the one on show whose agent has stopped to wait for the person — another
   * Chat, or a run of this one. Nothing on the page said so: the only sign was a dot on a row of the
   * session list, which a narrow or compact window does not show, and the agent waited unanswered.
   */
  elsewhere: string | undefined
}): ReactNode {
  if (activity === 'running')
    return (
      <span className="chat-activity" role="status">
        {t('chatRunning')}
      </span>
    )
  if (activity === 'waiting')
    return (
      <button type="button" className="chat-activity chat-activity-waiting" onClick={chat.showChat}>
        {t('chatWaiting')}
      </button>
    )
  if (elsewhere !== undefined)
    return (
      <button type="button" className="chat-activity chat-activity-waiting" onClick={() => chat.showSession(elsewhere)}>
        {t('chatWaitingElsewhere')}
      </button>
    )
  return null
}
