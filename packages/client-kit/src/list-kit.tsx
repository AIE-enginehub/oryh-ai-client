import { IconArrowLeft, IconChevronRight, IconPlus, IconRefresh } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { Button, Notice, Spinner } from './controls.js'
import type { OryhText } from './locale.js'
import type { StatusTone } from './status-words.js'

/**
 * The one way every business page says the same thing.
 *
 * Pages had drifted apart phrase by phrase: a row opened with ">" on one list, 「打开」 on another and
 * 「查看」 on a third; the count read 「筛选结果N条」, 「共 N 条」 or 「共 N 条 · 当前 N 条」; back was an icon
 * in one place and a "←" character in another; status was a pill here and a Fluent Badge there. None
 * of it was wrong on its own, and all of it together made the workbench feel like several products.
 *
 * So these pieces exist once, and pages compose them instead of writing their own. The copy lives here
 * too, in one place, for the day the workbench is translated. `docs/25-ui-conventions.md` records the
 * rules; `list-kit.spec.ts` fails a page that goes back to spelling them out by hand.
 */

/**
 * The top of every business page: an optional way back, the title, and the page's actions.
 * @param title - the menu label on a list page; the record's or form's name on a detail or form.
 * @param back - a {@link BackToList}, on details and forms only.
 * @param status - a {@link StatusPill} beside the title, when what is open has a status.
 * @param note - one short muted line about the page's state.
 * @param actions - buttons on the right: {@link RefreshButton} first, then {@link NewButton}.
 * @param tabs - the page's views, under the title.
 */
export function PageHeader({
  title,
  back,
  status,
  note,
  actions,
  tabs,
}: {
  title: ReactNode
  back?: ReactNode
  status?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  tabs?: ReactNode
}) {
  return (
    <header className="business-page-header">
      {back}
      <div className="list-actions">
        <div className="page-title">
          <h1>{title}</h1>
          {status}
          {note ? <span className="muted">{note}</span> : null}
        </div>
        {actions ? <div className="toolbar">{actions}</div> : null}
      </div>
      {tabs}
    </header>
  )
}

const reveal = (row: HTMLTableRowElement | null) => row?.scrollIntoView?.({ block: 'nearest' })

/**
 * What a row wears when Chat has just written its record: a mark, and a place on screen.
 * @param t - the frame's words.
 * @param written - whether the agent's last writing turn named this row's record.
 * @returns props for the row's `<tr>`.
 */
export function writtenRowProps(
  t: OryhText,
  written: boolean,
): {
  className?: string
  title?: string
  ref?: (row: HTMLTableRowElement | null) => void
} {
  // The ref is one function for every row, so it runs when a row becomes written, not at every render.
  return written ? { className: 'chat-wrote', title: t('rowWritten'), ref: reveal } : {}
}

/** Header cell of the row-open column: named for screen readers, empty to the eye. */
export function RowOpenHeader({ t }: { t: OryhText }) {
  return (
    <th scope="col" className="row-open-cell">
      <span className="sr-only">{t('rowActions')}</span>
    </th>
  )
}

/**
 * The trailing ">" that opens a row's detail. Every list whose rows open has it, and nothing else.
 * @param title - what the row is called, so the button says what it opens.
 * @param onOpen - opens the detail.
 * @param disabled - while the list is busy.
 * @param ask - what the row offers beside opening it, such as its own 「问 AI」; drawn before the ">".
 */
export function RowOpenCell({
  t,
  title,
  onOpen,
  disabled,
  ask,
}: {
  t: OryhText
  title: string
  onOpen: () => void
  disabled?: boolean
  ask?: ReactNode
}) {
  return (
    <td className="row-open-cell">
      {ask}
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('rowView', { title })}
        title={t('rowView', { title })}
        icon={<IconChevronRight size={16} />}
        disabled={Boolean(disabled)}
        onClick={onOpen}
      />
    </td>
  )
}

/** Leave a detail or form for the list it came from. */
export function BackToList({ t, onClick, disabled }: { t: OryhText; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="ghost" icon={<IconArrowLeft size={17} />} disabled={Boolean(disabled)} onClick={onClick}>
      {t('listBack')}
    </Button>
  )
}

/** Re-read a list from the server. */
export function RefreshButton({ t, onClick, disabled }: { t: OryhText; onClick: () => void; disabled?: boolean }) {
  return (
    <Button disabled={Boolean(disabled)} icon={<IconRefresh size={17} />} onClick={onClick}>
      {t('listRefresh')}
    </Button>
  )
}

/**
 * Start a new record from a list.
 * @param children - what is created, spelled 「新建…」.
 */
export function NewButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button variant="primary" icon={<IconPlus size={17} />} disabled={Boolean(disabled)} onClick={onClick}>
      {children}
    </Button>
  )
}

/** Drop every search and filter condition a list has. */
export function ClearConditionsButton({ t, onClick }: { t: OryhText; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" onClick={onClick}>
      {t('listClear')}
    </Button>
  )
}

/** A status, always as a pill. Lists and detail headers alike; no Fluent Badge for status. */
export function StatusPill({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`record-status status-${tone}`}>{children}</span>
}

/** A list or page reading from the server. */
export function ListLoading({ t, label }: { t: OryhText; label?: string }) {
  return (
    <div className="list-loading" role="status">
      <Spinner size="sm" />
      {label ?? t('listLoading')}
    </div>
  )
}

/**
 * Something failed. A read that can simply be repeated offers to do so; a failed action does not,
 * because repeating it is the person's decision.
 * @param message - what failed, as the service said it.
 * @param onRetry - repeats the read, when there is one to repeat.
 * @param ask - a way to ask about the failure, where the page has one; drawn after the retry.
 */
export function ErrorNote({
  t,
  message,
  onRetry,
  disabled,
  ask,
}: {
  t: OryhText
  message: ReactNode
  onRetry?: () => void
  disabled?: boolean
  ask?: ReactNode
}) {
  return (
    <Notice
      intent="error"
      role="alert"
      actions={
        <>
          {onRetry ? (
            <Button size="sm" disabled={Boolean(disabled)} onClick={onRetry}>
              {t('listReload')}
            </Button>
          ) : null}
          {ask}
        </>
      }
    >
      {message}
    </Notice>
  )
}

/**
 * The server may have moved on while a form held unsaved edits — usually a write made in Chat.
 * Refreshing shows the server's version and gives those edits up, which is why the button says so.
 * @param onRefresh - discards the unsaved edits and re-reads the document.
 */
export function StaleNote({ t, onRefresh, disabled }: { t: OryhText; onRefresh: () => void; disabled?: boolean }) {
  return (
    <Notice
      intent="warning"
      actions={
        <Button size="sm" disabled={Boolean(disabled)} onClick={onRefresh}>
          {t('staleDiscardAndRefresh')}
        </Button>
      }
    >
      {t('staleNote')}
    </Notice>
  )
}

/**
 * What a list shows when it has no rows. Filtered-to-nothing and genuinely empty say different things,
 * so the page passes which one it is rather than inventing its own sentence.
 * @param filtered - whether search or query conditions are narrowing the list.
 * @param title - replaces the heading where "records" is the wrong word, such as local drafts.
 * @param hint - what the person can do next, when the page has something better than the default.
 * @param children - an optional action, such as creating the first record.
 */
export function EmptyState({
  t,
  filtered,
  title,
  hint,
  children,
}: {
  t: OryhText
  filtered: boolean
  title?: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <div className="empty-state">
      <h3>{title ?? (filtered ? t('emptyFiltered') : t('emptyNone'))}</h3>
      <p>{hint ?? (filtered ? t('emptyFilteredHint') : t('emptyNoneHint'))}</p>
      {children}
    </div>
  )
}

/**
 * Count and paging under a list.
 *
 * The count must not claim more than it knows. A server-paged list knows its total; a list that loaded
 * one batch and filters it in the browser does not, and says so — unifying the wording must never turn
 * a partial count into a false total.
 * @param count - rows the count describes.
 * @param partial - true when the count covers only what this page loaded, not the server's total.
 */
export function ListFooter({
  t,
  count,
  partial = false,
  page,
  pages,
  onPage,
  disabled,
}: {
  t: OryhText
  count: number
  partial?: boolean
  page: number
  pages: number
  onPage: (page: number) => void
  disabled?: boolean
}) {
  return (
    <footer className="table-footer">
      <span>{partial ? t('footerPartial', { count }) : t('footerTotal', { count })}</span>
      <div className="pagination">
        <Button size="sm" disabled={Boolean(disabled) || page <= 1} onClick={() => onPage(page - 1)}>
          {t('footerPrevious')}
        </Button>
        <span>
          {page} / {pages}
        </span>
        <Button size="sm" disabled={Boolean(disabled) || page >= pages} onClick={() => onPage(page + 1)}>
          {t('footerNext')}
        </Button>
      </div>
    </footer>
  )
}

export { formatDate, formatDateTime, formatDisplayDate, formatDisplayValue } from './dates.js'
