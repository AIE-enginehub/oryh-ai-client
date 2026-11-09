/**
 * How the workbench tells the pane service what is on show, and which Chat that is.
 *
 * The binding itself — bind, stream, sync, rebind — is the service's (`pane-service.ts`). What is left
 * here is React's part: saying which session, connection and page are on screen.
 */

import { useEffect, useLayoutEffect } from 'react'
import type { PaneService, PaneTarget } from './pane-service.js'

/** The session rows the pane chooses its Chat from, as Harness's session list keeps them. */
export interface SessionRows {
  readonly byId: Readonly<
    Record<
      string,
      {
        readonly id: string
        readonly origin?: 'subagent'
        readonly parentId?: string
        readonly retainedBy: Readonly<Partial<Record<string, number>>>
      }
    >
  >
}

/**
 * The Chat the business pane binds to: the session the main view holds — or, when that is a subagent's
 * conversation opened from a Chat (a custom page's refresh, say), the Chat it belongs to. A run has no
 * workspace or page of its own, and bound to one the pane could not show the page it came from.
 * @param state - Harness's session list.
 * @returns the session id, or undefined when the main view holds none.
 */
export function businessSessionOf(state: SessionRows): string | undefined {
  let row = Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)
  let id = row?.id
  const seen = new Set<string>()
  while (row?.origin === 'subagent' && row.parentId !== undefined && !seen.has(row.parentId)) {
    seen.add(row.parentId)
    id = row.parentId
    row = state.byId[row.parentId]
  }
  return id
}

/**
 * Whether the main view holds a subagent's conversation — a review's, a page refresh's — and not the Chat
 * the pane is bound to. What a page then says to Chat lands in a conversation that is not on show.
 * @param state - Harness's session list.
 */
export function showsSubagent(state: SessionRows): boolean {
  return Object.values(state.byId).some(
    session => (session.retainedBy.mainView ?? 0) > 0 && session.origin === 'subagent',
  )
}

/**
 * Tell the pane service what the workbench has on show. Leaving — the connection screen, another
 * enterprise — withdraws the binding.
 * @param service - the plugin's pane service.
 * @param target - the bound session and whether the Host holds any, its connection, the page showing.
 */
export function usePaneTarget(service: PaneService, target: PaneTarget): void {
  const { sessionId, noSessions, connectionId, page, scope } = target
  // Before paint, as the pages report what they show: the sync that follows a page change carries both.
  useLayoutEffect(() => {
    service.show({ sessionId, noSessions, connectionId, page, scope })
  }, [service, sessionId, noSessions, connectionId, page, scope])
  useEffect(() => () => service.show(undefined), [service])
}
