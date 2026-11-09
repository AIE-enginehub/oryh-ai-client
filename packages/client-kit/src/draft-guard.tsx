import { useEffect } from 'react'
import { Button, Dialog } from './controls.js'
import type { OryhText } from './locale.js'

/** Protect browser navigation without persisting business contents in browser preferences. */
export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

/** Page-local draft decisions; never performs a business save or an approval. */
export function DraftLeaveDialog({
  open,
  onCancel,
  onDiscard,
  onKeep,
  t,
}: {
  open: boolean
  t: OryhText
  onCancel: () => void
  onDiscard: () => void
  onKeep?: () => void
}) {
  if (!open) return null
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={t('draftTitle')}
      closeLabel={t('dialogClose')}
      actions={
        <>
          <Button onClick={onDiscard}>{t('draftDiscard')}</Button>
          {onKeep && <Button onClick={onKeep}>{t('draftKeep')}</Button>}
          <Button variant="primary" onClick={onCancel}>
            {t('draftContinue')}
          </Button>
        </>
      }
    >
      <p>{onKeep ? t('draftKeepHint') : t('draftDiscardHint')}</p>
    </Dialog>
  )
}
