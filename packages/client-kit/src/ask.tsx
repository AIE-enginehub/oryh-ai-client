/**
 * Asking the agent from a page.
 *
 * A page could show a record and Chat could talk about it, but the only way from one to the other was to
 * go and type. Custom pages got a 「问 Chat」 of their own; the built-in pages had none. This is theirs:
 * a button on an open record, on a row of a list, and on an error a page shows. It opens the question
 * for the person to read and reword before it goes — it is sent as their turn, so it is theirs to see
 * first — and the agent already reads the page beside it, so "this record" needs no retelling. A
 * question from a row says which row: the page shows many.
 *
 * Someone who has no Chat session yet is given one first: a page must not need the person to have
 * opened Chat before it can ask on their behalf.
 */

import type { PaneAskSubject } from '@oryh/dsh-pane/types'
import { IconCheck, IconMessageQuestion, IconSend } from '@tabler/icons-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button, Popover } from './controls.js'
import type { PageFace } from './frame.js'
import type { OryhText } from './locale.js'
import { type PaneLocalState, usePane } from './pane.js'

const shownKey = (state: PaneLocalState) => state.context?.key

export { type ChatActions, type ChatActivity, ChatActivityNote } from './chat-context.js'

const SESSION_WAIT_MS = 10_000

/** The longest question a page sends; the Host takes a little more, for what it adds about where. */
const QUESTION_LIMIT = 400

/**
 * What 「问 AI」 asks beside an error a page shows.
 * @param t - the frame's words.
 * @param message - the error as the page shows it.
 */
export function errorQuestion(t: OryhText, message: string): string {
  return t('askErrorQuestion', { message: message.slice(0, 300) })
}

/**
 * The session a page acts in, started first when there is none.
 * @param face - what the page's slot handed it.
 * @returns `ensure()`, which resolves with a session the pane is bound to, and throws in words for the
 *   person when none could be had.
 */
export function useChatSession(face: PageFace): { ensure(): Promise<string> } {
  const { sessionId, chat, t } = face.frame
  const { status } = usePane(face)
  // Read by a wait that outlives the render it began in.
  const latest = useRef({ sessionId, status })
  latest.current = { sessionId, status }
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return {
    async ensure() {
      const bound = () => (latest.current.status === 'synced' ? latest.current.sessionId : undefined)
      if (bound()) return bound()!
      // No session at all: start one. One that is still binding only needs waiting for.
      if (latest.current.sessionId === undefined && !chat.startSession()) throw new Error(t('askNoSession'))
      for (const deadline = Date.now() + SESSION_WAIT_MS; Date.now() < deadline && alive.current; ) {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (bound()) return bound()!
      }
      throw new Error(t('askSessionNotReady'))
    },
  }
}

/**
 * Ask the agent something from a page.
 * @param face - what the page's slot handed it.
 * @returns `ask(question)`, and where the last asking stands, for the page to show.
 */
export function useAskChat(face: PageFace): {
  ask(question: string, subject?: PaneAskSubject): Promise<void>
  asking: boolean
  note: string
  /** Whether what `note` says is that the question did not go. */
  failed: boolean
} {
  const { remote, local, usePaneLocal } = face
  const { chat, t } = face.frame
  const connectionId = face.connection.id
  const session = useChatSession(face)
  const [asking, setAsking] = useState(false)
  // Where an asking stands is said beside what was on the page when it was made. One button serves every
  // record a page opens, so a note kept by the button alone sat under records nobody had asked about.
  const [said, setSaid] = useState<{ text: string; shown: string | undefined; failed: boolean }>()
  const key = () => local.getSnapshot().context?.key
  const shown = usePaneLocal(shownKey)
  const setNote = (text: string, failed = false) => setSaid({ text, shown: key(), failed })
  // And it is said once: coming back to that record later does not bring it back.
  useEffect(() => setSaid(was => (was !== undefined && was.shown !== shown ? undefined : was)), [shown])
  return {
    asking,
    note: said !== undefined && said.shown === shown ? said.text : '',
    failed: said !== undefined && said.shown === shown && said.failed,
    async ask(question, subject) {
      if (asking) return
      setAsking(true)
      setSaid(undefined)
      try {
        const sessionId = await session.ensure()
        await remote.paneAsk({ sessionId, connectionId, question, ...(subject ? { subject } : {}) })
        // The answer is in Chat, so that is where the person is taken.
        chat.showChat()
        setNote(t('askSent'))
      } catch (reason) {
        setNote(reason instanceof Error ? reason.message : t('askNotSent'), true)
      } finally {
        setAsking(false)
      }
    },
  }
}

/**
 * 「问 AI」: a question about what the page shows, opened for the person to read and reword, then put to
 * the agent as their turn.
 * @param face - what the page's slot handed it.
 * @param question - what is suggested, written as the person would ask it; they may write their own.
 * @param subject - the one row the question is about, on a list.
 * @param compact - the icon alone, for a row of a table.
 * @param children - the button's words, where 「问 AI」 is not enough.
 */
export function AskAi({
  face,
  question,
  subject,
  compact,
  children,
}: {
  face: PageFace
  question: string
  subject?: PaneAskSubject
  compact?: boolean
  children?: ReactNode
}): ReactNode {
  const { ask, asking, note, failed } = useAskChat(face)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(question)
  const box = useRef<HTMLTextAreaElement>(null)
  // Selected as it opens, so typing replaces the suggestion and Enter sends it as it is. A moment after
  // the popover has placed its own focus — selecting on the focus event itself was undone by that — and by
  // a timer, not an animation frame: a tab that is not showing runs none.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      box.current?.focus()
      box.current?.select()
    }, 50)
    return () => clearTimeout(timer)
  }, [open])
  const send = () => {
    const asked = text.trim()
    if (!asked) return
    setOpen(false)
    void ask(asked, subject)
  }
  const { t } = face.frame
  const label = subject ? t('askAiAbout', { title: subject.title }) : t('askAi')
  return (
    <span className="ask-ai">
      <Popover
        open={open}
        label={label}
        className="ask-ai-box"
        onOpenChange={next => {
          // Opened afresh each time with what the page suggests: a question once sent is not kept to resend.
          if (next) setText(question)
          setOpen(next)
        }}
        trigger={toggle => (
          <Button
            variant="ghost"
            size="sm"
            // On a row there is no room to say the question went: the button says it, and Chat has come forward.
            icon={compact && note && !failed ? <IconCheck size={16} /> : <IconMessageQuestion size={16} />}
            disabled={asking}
            aria-expanded={open}
            onClick={toggle}
            {...(compact ? { 'aria-label': label, title: note && !failed ? note : label } : {})}
          >
            {compact ? null : (children ?? t('askAi'))}
          </Button>
        )}
      >
        <form
          onSubmit={event => {
            event.preventDefault()
            send()
          }}
        >
          <label>
            <span>{subject ? t('askAssistantAbout', { title: subject.title }) : t('askAssistantAboutPage')}</span>
            <textarea
              ref={box}
              rows={3}
              maxLength={QUESTION_LIMIT}
              value={text}
              placeholder={t('askPlaceholder')}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  send()
                }
              }}
            />
          </label>
          <div className="ask-ai-actions">
            <span className="muted">{t('askEnterHint')}</span>
            <Button size="sm" onClick={() => setOpen(false)}>
              {t('askCancel')}
            </Button>
            <Button size="sm" variant="primary" type="submit" icon={<IconSend size={14} />} disabled={!text.trim()}>
              {t('askSend')}
            </Button>
          </div>
        </form>
      </Popover>
      {note ? (
        // A failure is always said in words. That the question went is said beside a page's own button; on
        // a row it is for a screen reader only, where the words would crowd the column.
        <span className={compact && !failed ? 'sr-only' : 'muted'} role="status">
          {note}
        </span>
      ) : null}
    </span>
  )
}
