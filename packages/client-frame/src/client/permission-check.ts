/**
 * What a failed check of the account's grants means for the workbench.
 *
 * The workbench asks the Host who the person is and what they may do when it opens, and again when they
 * come back to the window after a while. That question goes to ORYH, over a network, and sometimes fails
 * for no reason that lasts: a request timed out, a credential was being renewed. One such failure used to
 * replace the whole pane with "refresh the page" — and stay that way, since nothing asked again.
 *
 * A failure that says nothing about the person leaves what was last verified in place and is asked again
 * shortly; every read is checked by the Host and by ORYH anyway, so grants a minute stale show nothing
 * that a revoked permission would not also refuse. Only a failure that is an answer — this is not that
 * person any more, the sign-in is gone — takes the pane away.
 */

/** Failures that are ORYH's or the Host's answer about the person, which asking again will not change. */
const FINAL = new Set(['connection-identity-mismatch', 'connection-not-found', 'authentication-failed'])

/**
 * Whether a failed check is an answer rather than a failure to ask.
 * @param reason - what the check rejected with.
 */
export function isFinalFailure(reason: unknown): boolean {
  const failure = reason as { code?: unknown; business?: unknown } | null
  return typeof failure === 'object' && failure !== null && failure.business === true && FINAL.has(String(failure.code))
}

/**
 * How long to wait before asking again after a number of failures in a row: 2 s, then twice as long each
 * time, up to half a minute. Soon enough that a blip is over before anyone notices; slow enough that an
 * ORYH that is down is not asked every second by every open tab.
 * @param failures - failures in a row so far, at least 1.
 */
export function retryDelay(failures: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1))
}

/** A path nothing serves: on the server version the front door answers it before any Host sees it. */
export const ENTRANCE_PROBE = '/oryh/entrance-probe'

/**
 * Whether the server version's front door no longer knows this browser.
 *
 * The owner domain's session is kept in the control process's memory. When that process restarts, the
 * page stays open with a cookie nothing recognises: every request is refused, and asking again changes
 * nothing — only entering again does, which signs nobody in afresh (the sign-in itself is remembered).
 * The front door says so in these exact words to anything that is not a navigation
 * (packages/server/src/control/front-door.ts). A desktop or local Host has no front door and never does.
 * @param answer - what the probe got back.
 */
export function entranceLost(answer: { status: number; text: string }): boolean {
  return answer.status === 403 && answer.text.trim() === 'Sign in again.'
}

/**
 * Whether entering again is worth doing now: once, then not again for a minute, so that a browser whose
 * sign-in really is gone lands on the sign-in page instead of reloading for ever.
 * @param last - when this tab last entered again, from its own storage; undefined if never.
 * @param now - the time now.
 */
export function mayEnterAgain(last: number | undefined, now: number): boolean {
  return last === undefined || !Number.isFinite(last) || now - last > 60_000
}

/**
 * Enter again if the front door no longer knows this page; otherwise do nothing.
 *
 * Called where the page notices it is not being answered — the account check failing twice, the pane's
 * binding failing twice — since a page that is only being looked at notices in one place and a page being
 * used in the other.
 */
export async function enterAgainIfLost(): Promise<void> {
  try {
    const answer = await fetch(ENTRANCE_PROBE, { cache: 'no-store', credentials: 'same-origin' })
    if (!entranceLost({ status: answer.status, text: await answer.text() })) return
    const key = 'oryh-entered-again'
    const last = Number(window.sessionStorage.getItem(key) ?? Number.NaN)
    if (!mayEnterAgain(Number.isNaN(last) ? undefined : last, Date.now())) return
    window.sessionStorage.setItem(key, String(Date.now()))
    window.location.reload()
  } catch {
    /* the network is down or storage is closed: whoever called goes on retrying */
  }
}
