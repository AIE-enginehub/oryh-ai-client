import type { UserViewSummary } from '@oryh/dsh-pane/types'
import { IconCopy, IconShare, IconShareOff } from '@tabler/icons-react'
import { type ReactNode, useEffect, useState } from 'react'
import { ErrorNote } from './ask-notes.js'
import { Button } from './controls.js'
import type { PageFace } from './frame.js'
import { userViewPage } from './user-views.js'

/**
 * What the page of a menu entry — a list, a custom page — says and offers about sharing it with colleagues.
 *
 * The person's own can be shared and withdrawn; a colleague's says whose it is and can be copied, which
 * is how a person gets one of their own to change. Nothing is offered where the deployment keeps no
 * library (the desktop), for an entry the person's role implies, or for a built-in list.
 * @param view - the entry the page is opened as, if it is one.
 * @returns the header's button and note, and the failure of the last click to show under the header.
 */
export function useViewSharing(
  face: PageFace,
  view: UserViewSummary | undefined,
): { action?: ReactNode; note?: string; error?: ReactNode } {
  const { sessionId, menu, navigate, t } = face.frame
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A copy is opened once the menu has it: the Host answers the click and publishes the menu apart, and
  // a page opened as an entry the menu does not have yet reads as one that was removed.
  const [copied, setCopied] = useState<string>()
  useEffect(() => {
    if (!copied || !menu.views.some(v => v.id === copied)) return
    setCopied(undefined)
    navigate(userViewPage(copied))
  }, [copied, menu.views, navigate])
  // The entry changed under the page: what the last click said is no longer about this one.
  const viewId = view?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleared when the page is opened as another entry
  useEffect(() => setError(''), [viewId])
  // A colleague's entry is itself the sign that sharing is on offer: with no session open the menu comes
  // from the connection alone and says nothing of it, and the entry still says whose it is.
  if (!view || view.origin === 'role' || !(menu.sharing || view.origin === 'shared')) return {}
  const run = (work: (request: { sessionId: string; connectionId: typeof face.connection.id }) => Promise<unknown>) => {
    if (!sessionId) return
    setBusy(true)
    setError('')
    void work({ sessionId, connectionId: face.connection.id })
      .catch(reason => setError(reason instanceof Error ? reason.message : t('shareFailed')))
      .finally(() => setBusy(false))
  }
  // The entry lives in the workspace of a Chat session, so sharing or copying one needs a session open.
  const hint = sessionId ? undefined : t('shareNeedsSession')
  const failed = error ? <ErrorNote face={face} message={error} /> : undefined
  if (view.origin === 'shared')
    return {
      note: t('viewSharedBy', { name: view.sharedBy ?? '' }),
      action: (
        <Button
          disabled={busy || !sessionId || copied !== undefined}
          title={hint ?? t('copySharedHint')}
          icon={<IconCopy size={17} />}
          onClick={() =>
            run(async request => {
              const copy = await face.remote.paneCopySharedView({ ...request, sharedViewId: view.id })
              // A copied list is in the menu at once. A copied page enters it once it has run: the person
              // is taken to their own pages, where it is listed and can be refreshed.
              if (copy.kind === 'page') navigate('analytics')
              else setCopied(copy.id)
            })
          }
        >
          {t('copyShared')}
        </Button>
      ),
      ...(failed ? { error: failed } : {}),
    }
  const shared = view.shared === true
  return {
    ...(shared ? { note: t('viewSharedNote') } : {}),
    action: (
      <Button
        disabled={busy || !sessionId}
        title={hint ?? (shared ? t('unshareHint') : t('shareHint'))}
        icon={shared ? <IconShareOff size={17} /> : <IconShare size={17} />}
        onClick={() => run(request => face.remote.paneShareView({ ...request, userViewId: view.id, shared: !shared }))}
      >
        {shared ? t('unshare') : t('share')}
      </Button>
    ),
    ...(failed ? { error: failed } : {}),
  }
}
