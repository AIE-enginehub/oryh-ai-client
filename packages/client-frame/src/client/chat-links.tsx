/**
 * A record's link in a Chat answer opens that record in the business pane.
 *
 * The agent names a record in prose — SO202606002 — and until now that was all it was: text. The person
 * who wanted to see the order went looking for it. The agent now writes the record's page in the ORYH
 * console as the link, which is good anywhere the answer is read; here a click on it is taken before
 * Harness opens it in a browser tab, and the Host shows the record in the pane instead.
 *
 * A record no page of this client shows goes where the link points, to the console — in the click
 * itself. The Host says beforehand which kinds its pages show, so that case never waits on an answer:
 * a tab opened after one is, to a browser, a pop-up, and may be blocked. A record the pane then fails to
 * show is said so beside the conversation, with the console's link there to click.
 *
 * Only links inside Chat: the pages' own 「打开 ORYH 完整记录」 has the same address and means the console.
 */
import { type PageFace, usePane } from '@oryh/ai-client-kit'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const RECORD_PATH = /^\/console\/objects\/([A-Za-z][A-Za-z0-9_-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\/?$/
/** How long a failure stays beside the conversation before it clears itself. */
const NOTE_MS = 15_000

/**
 * The record a link names, when it is a record of this enterprise's ORYH.
 * @param href - the link's address.
 * @param origin - the ORYH this connection is to.
 * @returns the object type and id, or undefined for any other address.
 */
export function recordLink(href: string, origin: string): { type: string; id: string } | undefined {
  let url: URL, home: URL
  try {
    url = new URL(href)
    home = new URL(origin)
  } catch {
    return undefined
  }
  if (url.origin !== home.origin) return undefined
  const match = RECORD_PATH.exec(url.pathname)
  return match ? { type: match[1]!, id: decodeURIComponent(match[2]!) } : undefined
}

/**
 * Where a click on a record link goes: to the pane, or on to the console as the link says.
 * @param type - the object type or collection the link names.
 * @param shown - the names the Host says its pages show; undefined while it has not said.
 * @returns `pane` unless the Host has said and this is not among them.
 */
export function linkTarget(type: string, shown: readonly string[] | undefined): 'pane' | 'console' {
  return shown !== undefined && !shown.includes(type) ? 'console' : 'pane'
}

/** Mounted with the workbench: takes clicks on record links in Chat for as long as a session is bound. */
export function ChatRecordLinks({ face }: { face: PageFace }): ReactNode {
  const { remote, connection } = face
  const { sessionId, t } = face.frame
  const shown = usePane(face).state.recordLinks
  const names = shown?.join('\n')
  // A record the pane did not show: why, and the link to the console to click instead.
  const [failed, setFailed] = useState<{ href: string; notice: string }>()
  // Only the click made last says how it went. A click replaces the one before it on the Host, and that
  // one then comes back as superseded: said beside a record that had just opened, it read as a failure.
  const clicks = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `names` is `shown`, by content.
  useEffect(() => {
    if (sessionId === undefined) return
    const onClick = (event: MouseEvent) => {
      // A modified click asks for a new tab, and gets what it asked for.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('.oryh-chat-seat a[href]')
      // The link in our own notice means the console, and goes there.
      if (anchor?.hasAttribute('data-oryh-console')) return
      const href = anchor?.getAttribute('href')
      const link = href ? recordLink(href, connection.origin) : undefined
      if (!href || !link || linkTarget(link.type, shown) === 'console') return
      // Before Harness's own handler, which would open the address in a browser tab.
      event.preventDefault()
      event.stopPropagation()
      setFailed(undefined)
      const click = ++clicks.current
      const say = (notice: string | undefined) => {
        if (clicks.current === click) setFailed({ href, notice: notice || t('linkNotOpened') })
      }
      remote.paneOpenRecord({ sessionId, connectionId: connection.id, ...link }).then(
        result => {
          if (!result.opened) say(result.notice)
        },
        reason => say(reason instanceof Error ? reason.message : undefined),
      )
    }
    // On the document, in the capture phase: above the root Harness renders into, so ahead of its handlers.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [remote, sessionId, connection.id, connection.origin, names])
  useEffect(() => {
    if (!failed) return
    const timer = setTimeout(() => setFailed(undefined), NOTE_MS)
    return () => clearTimeout(timer)
  }, [failed])
  const seat = failed ? document.querySelector('.oryh-chat-seat') : null
  if (!failed || !seat) return null
  return createPortal(
    <div className="chat-link-note" role="status">
      <span>{failed.notice}</span>
      <a
        href={failed.href}
        target="_blank"
        rel="noopener noreferrer"
        data-oryh-console=""
        onClick={() => setFailed(undefined)}
      >
        {t('linkOpenInOryh')}
      </a>
      <button type="button" aria-label={t('linkDismiss')} onClick={() => setFailed(undefined)}>
        ×
      </button>
    </div>,
    seat,
  )
}
