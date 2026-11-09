import type { ConnectionSummary, OperationId, OryhOperationResult, SavedOperationView } from '@oryh/ai-client-core'
import type { PaneContext } from '@oryh/dsh-pane/types'
import { IconArrowUpRight, IconSearch } from '@tabler/icons-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { AskAi } from './ask.js'
import { ErrorNote, RowOpenCell } from './ask-notes.js'
import { type BusinessRow, businessRows, emptyFilter, filterRows, type ViewFilter } from './business-data.js'
import type { BusinessText } from './business-locales.js'
import { Button, Field, Input, LinkButton, Notice, Select } from './controls.js'
import { formatDateTime, formatDisplayValue } from './dates.js'
import { displayStatus } from './display-language.js'
import type { PageFace } from './frame.js'
import {
  BackToList,
  ClearConditionsButton,
  EmptyState,
  ListFooter,
  ListLoading,
  PageHeader,
  RefreshButton,
  RowOpenHeader,
  StatusPill,
  writtenRowProps,
} from './list-kit.js'
import { useCommand, useServerRefresh, useWrittenRecords } from './pane.js'
import { statusTone } from './status-words.js'
import { filterPreference, PreferenceDetails, pagePreference, useViewPreference } from './view-preferences.js'

/** What a list of this kind can be narrowed by: a keyword, a status, a span of its dates. */
const LIST_CONDITIONS = ['text', 'status', 'from', 'to'] as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The conditions a list of this kind takes, out of whatever it was handed.
 *
 * Set by name through `oryh_list_filter`, they arrive as they are. Carried over from a read the agent
 * made in Chat, they are ORYH's own parameters: a status is a status either way, and a search goes by
 * several names. What this list cannot narrow by — whose todos, which customer — is left out; several
 * statuses at once are too, since the list shows one.
 * @param values - condition name to value.
 */
export function listConditions(values: Record<string, string>): Partial<ViewFilter> {
  const next: Partial<ViewFilter> = {}
  const text = values.text ?? values.q ?? values.search ?? values.keyword
  if (typeof text === 'string' && text.trim()) next.text = text.trim().slice(0, 200)
  if (typeof values.status === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(values.status))
    next.status = values.status
  if (typeof values.from === 'string' && DAY.test(values.from)) next.from = values.from
  if (typeof values.to === 'string' && DAY.test(values.to)) next.to = values.to
  return next
}

/** What a page reports about itself to Chat: the Host's pane context, as the pages fill it in. */
export type PageContext = PaneContext

/**
 * The list as the page shows it, for the pieces a page plugin adds around it: which rows are on
 * screen and in what order, what is open, and how to open a row.
 */
export interface ListHandle {
  readonly rows: readonly BusinessRow[]
  /** The rows on the current page, in the order the person sees; the agent refers to them by position. */
  readonly visibleRows: readonly BusinessRow[]
  /** Changes with the visible order, so a position the agent read is only good for that order. */
  readonly listRevision: string
  readonly selected: BusinessRow | undefined
  readonly result: OryhOperationResult | undefined
  readonly active: boolean
  readonly busy: boolean
  openRecord(id: string): void
}

/**
 * One fixed ORYH read operation as a page: its rows, filters, paging, saved views and the open record.
 *
 * The page plugins compose it: a different table, extra filters, extra actions, a richer detail, and
 * whatever their page adds to the context the Host reads. Nothing here knows which operation it is.
 */
export function BusinessPage({
  face,
  connection,
  operationId,
  resource,
  title,
  active,
  onContext,
  tabs,
  actions,
  filters,
  renderTable,
  renderDetail,
  extraContext,
  secondaryColumn,
  dateLabel: dateLabelProp,
  defaultStatus,
  children,
}: {
  /** What the page's slot handed it: the pane, the Remote, the words. */
  face: PageFace
  connection: ConnectionSummary
  operationId: OperationId
  /**
   * The ORYH collection the rows are records of (`projects`), where they are. A row then carries a
   * 「问 AI」 of its own, and the question names the record by collection and id.
   */
  resource?: string
  /** What the page is called, as the menu says it. */
  title: string
  active: boolean
  onContext: (value: PageContext) => void
  /** The page's views, shown under its title while the list is open. */
  tabs?: ReactNode
  /** Buttons after the refresh button on the list header. */
  actions?: ReactNode
  /** Extra filter sections under the sorting section. */
  filters?: ReactNode
  /** The table for the rows, when the default title/status/secondary/date one does not fit. */
  renderTable?: (handle: ListHandle) => ReactNode
  /** The body of the open record, when the default field list does not fit. */
  renderDetail?: (handle: ListHandle) => ReactNode
  /** What the page adds to the context the Host reads. */
  extraContext?: (handle: ListHandle) => Partial<PageContext>
  /** The default table's third column heading. */
  secondaryColumn?: string
  /** What the row date means on this page. */
  dateLabel?: string
  /**
   * The status the list opens on, where the page loads more than its everyday view — "my todos" loads
   * what is done as well as what is open, and opens on the open ones.
   */
  defaultStatus?: string
  /** Rendered beside the list, given the list handle: bridges, chat panels. */
  children?: (handle: ListHandle) => ReactNode
}): ReactNode {
  const t: BusinessText = face.frame.t
  // The shared pieces name their own words in the same dictionary.
  const say = face.frame.t
  const { remote } = face
  const [result, setResult] = useState<OryhOperationResult>()
  const [busy, setBusy] = useState(false)
  // Saving a shortcut does not reload the list: blanking the rows while it runs also told the agent the
  // page had no rows to talk about.
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // A page with a default status keeps its filter under a key of its own: a filter saved before the list
  // loaded anything but its default meant that default, and must not come back meaning "everything".
  const [filter, setFilter] = useViewPreference<ViewFilter>(
    face,
    defaultStatus ? `${operationId}:filter:${defaultStatus}` : `${operationId}:filter`,
    defaultStatus ? { ...emptyFilter, status: defaultStatus } : emptyFilter,
    filterPreference,
  )
  const [page, setPage] = useViewPreference(face, `${operationId}:page`, 1, pagePreference)
  const [selectedId, setSelectedId] = useState<string>()
  const [saved, setSaved] = useState<readonly SavedOperationView[]>([])
  const [label, setLabel] = useState('')
  const [saveMessage, setSaveMessage] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const listScroll = useRef(0)
  function openRecord(id: string) {
    const main = root.current?.closest<HTMLElement>('.oryh-business-seat')
    listScroll.current = main?.scrollTop ?? 0
    setSelectedId(id)
    requestAnimationFrame(() => {
      if (main) main.scrollTop = 0
      root.current?.querySelector<HTMLButtonElement>('.business-page-header button')?.focus()
    })
  }
  function returnToList() {
    setSelectedId(undefined)
    requestAnimationFrame(() => {
      const main = root.current?.closest<HTMLElement>('.oryh-business-seat')
      if (main) main.scrollTop = listScroll.current
      const target = root.current?.querySelector<HTMLButtonElement>(
        `button[data-row-id="${CSS.escape(selectedId ?? '')}"]`,
      )
      target?.focus({ preventScroll: true })
    })
  }
  const loaded = useRef(false)
  const alive = useRef(true)
  const running = useRef(false)
  /** A refresh asked for while a read was running; that read may predate the change, so it runs again. */
  const again = useRef(false)
  const contextCallback = useRef(onContext)
  contextCallback.current = onContext
  const rows = useMemo(() => (result ? businessRows(result, t) : []), [result, t, face.frame.t('interfaceLanguage')])
  const filtered = useMemo(() => filterRows(rows, filter), [rows, filter])
  // A record stays open across a re-read even when it leaves the list: a todo approved from Chat drops out
  // of "my open todos", and the person should see it done where they were working it, not see it vanish.
  const lastSelected = useRef<BusinessRow>(undefined)
  // A record opened by id that the list has not loaded — older than what it reads, or past its first
  // page — is read by itself and shown as any other; the list beside it stays what it was.
  const [apart, setApart] = useState<BusinessRow>()
  const found = rows.find(row => row.id === selectedId) ?? (apart?.id === selectedId ? apart : undefined)
  if (found) lastSelected.current = found
  const selected = found ?? (lastSelected.current?.id === selectedId ? lastSelected.current : undefined)
  const pages = Math.max(1, Math.ceil(filtered.length / 12))
  const currentPage = Math.min(page, pages)
  const dateLabel = dateLabelProp ?? t('text30')
  const invalidDates = Boolean(filter.from && filter.to && filter.from > filter.to)
  const conditionList = [
    filter.text && t('text31', { value0: filter.text }),
    filter.status && t('text32', { value0: displayStatus(face.frame.t, filter.status) }),
    filter.from && t('text33', { value0: dateLabel, value1: filter.from }),
    filter.to && t('text34', { value0: filter.to }),
  ].filter(Boolean)
  const conditions = conditionList.join(' · ')
  const total = result?.result.meta.total ?? null
  // Filtering happens in the browser, so a count is only a total when every server row was loaded.
  const complete = total !== null && rows.length >= total
  // What the list shows once its filters apply: the footer's count, and the one the agent answers from.
  const shown = invalidDates ? 0 : filtered.length
  // The loaded and server counts come before any filter, and beside a filtered list they have to say so:
  // unmarked, 「本次载入 3 条 / 服务端共 3 条」 under 待处理 read as three open todos, to the agent too (docs/25).
  const loadedCount = t('text37', {
    value0: rows.length,
    value1: total !== null ? t('text35', { value0: total }) : t('text36'),
  })
  const unfiltered = conditions ? t('text191', { value0: loadedCount }) : loadedCount
  // The line under the list: what the footer's count was taken from.
  const caption = complete ? unfiltered : `${unfiltered}${t('text192')}`
  // The same for the agent, which has no footer: the count shown comes first, then what it was taken from.
  const shownWords = conditions ? t('text193', { value0: shown, value1: conditions }) : t('text194', { value0: shown })
  const scope = `${shownWords}。${caption}。`
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (active && !loaded.current) {
      loaded.current = true
      void load()
    }
  }, [active])
  const visibleRows = useMemo(
    () => (busy || invalidDates ? [] : filtered.slice((currentPage - 1) * 12, currentPage * 12)),
    [busy, invalidDates, filtered, currentPage],
  )
  // The order the person sees is what the agent refers to by position, so it carries a version of its own.
  const listKey = JSON.stringify({ ids: visibleRows.map(row => row.id), currentPage, filter, busy })
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision whenever the visible order changes.
  const listRevision = useMemo(() => crypto.randomUUID(), [listKey])
  const handle: ListHandle = { rows, visibleRows, listRevision, selected, result, active, busy, openRecord }
  const extra = extraContext?.(handle)
  const extraKey = JSON.stringify(extra)
  useEffect(() => {
    contextCallback.current({
      key: `${operationId}:${selected?.id ?? 'list'}`,
      title: selected?.title ?? title,
      detail: selected ? t('text38') : conditions || t('text39'),
      scope: result ? `${scope}${error ? t('text40') : ''}` : t('text41'),
      // What the open record is about, so the pane stays on it while the agent works on that document.
      ...(selected?.subject ? { subject: selected.subject } : {}),
      // What the list is narrowed by, in the names the agent sets it with (`oryh_list_filter`).
      listFilter: {
        fields: [...LIST_CONDITIONS],
        values: { text: filter.text, status: filter.status, from: filter.from, to: filter.to },
      },
      ...extra,
      content: JSON.stringify({
        loading: busy,
        error,
        // Each count is named for what it counts, so none of them can be read as another.
        counts: result
          ? {
              shownAfterFilters: shown,
              loadedBeforeFilters: rows.length,
              serverTotalBeforeFilters: total,
              allLoaded: complete,
            }
          : null,
        activeFilters: conditionList,
        filter,
        page: currentPage,
        pages,
        selected: selected ?? null,
        visibleRows,
      }),
    })
  }, [
    selected?.id,
    selected?.title,
    title,
    conditions,
    scope,
    operationId,
    result,
    error,
    busy,
    filter,
    currentPage,
    pages,
    filtered,
    extraKey,
  ])
  async function load(savedId?: SavedOperationView['id']) {
    if (running.current) {
      if (savedId === undefined) again.current = true
      return
    }
    running.current = true
    setBusy(true)
    setError('')
    try {
      const next = savedId
        ? await remote.refreshSavedOperation(connection.id, savedId)
        : await remote.execute(connection.id, operationId)
      if (!alive.current) return
      if (next.operationId !== operationId || next.connectionId !== connection.id) throw new Error(t('text42'))
      setResult(next)
      try {
        const entries = await remote.listSavedOperations(connection.id)
        if (alive.current) setSaved(entries.filter(entry => entry.operationId === operationId))
      } catch {
        if (alive.current) setSaveMessage(t('text43'))
      }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : t('text44'))
    } finally {
      running.current = false
      if (alive.current) setBusy(false)
      if (again.current && alive.current) {
        again.current = false
        void load()
      }
    }
  }
  /** Read one record of this list by its id, apart from the rows the list has loaded. */
  async function readApart(id: string): Promise<boolean> {
    try {
      const row = businessRows(await remote.executeOne(connection.id, operationId, id), t)[0]
      if (!alive.current || row?.id !== id) return false
      setApart(row)
      return true
    } catch {
      return false
    }
  }
  // Rows are matched by id, so an open record stays open across the re-read and shows its new state.
  // One that was read apart from the list is read again the same way.
  const written = useWrittenRecords(face, resource ?? '')
  useServerRefresh(face, active, () => {
    if (loaded.current) void load()
    if (apart && apart.id === selectedId) void readApart(apart.id)
  })
  // The agent opens one record by id: the one it just wrote, or one the person asked about. A record the
  // list holds opens from it; any other is read by itself, so what the list happens to have loaded does
  // not decide what can be opened. Only a record that cannot be read at all is said to be missing.
  const reading = useRef<string>(undefined)
  const [missing, setMissing] = useState<string>()
  useCommand(
    face,
    'navigation',
    operationId,
    command => {
      if (!active || command.target !== 'record' || !command.recordId) return false
      const id = command.recordId
      if (selected?.id === id) return true
      if (rows.some(row => row.id === id)) {
        openRecord(id)
        return false
      }
      if (missing === id) {
        setMissing(undefined)
        setError(t('text196'))
        return true
      }
      if (reading.current !== id) {
        reading.current = id
        void readApart(id).then(read => {
          reading.current = undefined
          if (!alive.current) return
          if (read) openRecord(id)
          else setMissing(id)
        })
      }
      return false
    },
    [active, selected?.id, rows, missing],
  )
  function update(patch: Partial<ViewFilter>) {
    setFilter(current => ({ ...current, ...patch }))
    setPage(1)
  }
  // The agent narrows the list — asked to, or because it has just read it that way in Chat. The
  // conditions given are the conditions: what they do not name is cleared, so the list is what was asked
  // for and not that crossed with what the page had before. The order the person chose stays.
  useCommand(
    face,
    'navigation',
    operationId,
    command => {
      if (!active || command.target !== 'filters') return false
      const next = listConditions(command.queryValues ?? {})
      setFilter(current => ({ ...emptyFilter, descending: current.descending, ...next }))
      setPage(1)
      return true
    },
    [active],
  )
  async function save() {
    if (!result || running.current || !label.trim()) return
    running.current = true
    setSaving(true)
    setSaveMessage('')
    try {
      const value = await remote.saveResult(connection.id, operationId, result.id, label.trim())
      if (alive.current) {
        setSaved(current => [...current, value])
        setLabel('')
        setSaveMessage(t('text45'))
      }
    } catch (reason) {
      if (alive.current) setSaveMessage(reason instanceof Error ? reason.message : t('text46'))
    } finally {
      running.current = false
      if (alive.current) setSaving(false)
    }
  }
  return (
    <>
      <div ref={root} className="business-page">
        {selected ? (
          <PageHeader
            back={<BackToList t={say} onClick={returnToList} />}
            title={selected.title}
            status={
              <StatusPill tone={statusTone(selected.status)}>{displayStatus(face.frame.t, selected.status)}</StatusPill>
            }
            actions={<AskAi face={face} question={say('askRecordQuestion')} />}
          />
        ) : (
          <PageHeader
            title={title}
            tabs={tabs}
            actions={
              <>
                <RefreshButton t={say} disabled={busy} onClick={() => void load()} />
                {actions}
              </>
            }
          />
        )}
        {error && (
          <ErrorNote
            face={face}
            message={
              <>
                {error} {result && t('text47')}
              </>
            }
            disabled={busy}
            onRetry={() => void load()}
          />
        )}
        {children?.(handle)}
        {selected ? (
          <section className="surface record-detail">
            {renderDetail ? (
              renderDetail(handle)
            ) : (
              <>
                <RecordFields t={t} record={selected} />
                <p className="muted">{t('text51')}</p>
                <OpenInConsole t={t} connection={connection} record={selected} />
              </>
            )}
          </section>
        ) : (
          <>
            {selectedId && !selected && <Notice>{t('text53')}</Notice>}
            <section className="surface table-surface" aria-label={title}>
              <div className="query-toolbar">
                <Field label={t('text58')}>
                  <Input
                    icon={<IconSearch size={16} />}
                    placeholder={t('text59')}
                    value={filter.text}
                    onChange={event => update({ text: event.target.value })}
                  />
                </Field>
                <Field label={t('text60')}>
                  <Select value={filter.status} onChange={event => update({ status: event.target.value })}>
                    <option value="">{t('text61')}</option>
                    {[...new Set([...rows.map(row => row.status), ...(filter.status ? [filter.status] : [])])].map(
                      status => (
                        <option key={status} value={status}>
                          {displayStatus(face.frame.t, status)}
                        </option>
                      ),
                    )}
                  </Select>
                </Field>
              </div>
              <PreferenceDetails face={face} preferenceKey={`${operationId}:section1`} className="advanced-filters">
                <summary>
                  {say('filtersMore')}
                  {filter.from || filter.to || !filter.descending ? say('filtersSet') : ''}
                </summary>
                <div className="advanced-filter-fields">
                  <Field label={t('text62', { value0: dateLabel })}>
                    <Input type="date" value={filter.from} onChange={event => update({ from: event.target.value })} />
                  </Field>
                  <Field label={t('text63')}>
                    <Input type="date" value={filter.to} onChange={event => update({ to: event.target.value })} />
                  </Field>
                  <Field label={t('text64')}>
                    <Select
                      value={filter.descending ? 'desc' : 'asc'}
                      onChange={event => update({ descending: event.target.value === 'desc' })}
                    >
                      <option value="desc">{t('text65')}</option>
                      <option value="asc">{t('text66')}</option>
                    </Select>
                  </Field>
                </div>
              </PreferenceDetails>
              {filters}
              {conditions && (
                <div className="filter-summary">
                  <span>{conditions}</span>
                  <ClearConditionsButton
                    t={say}
                    onClick={() => {
                      setFilter(emptyFilter)
                      setPage(1)
                    }}
                  />
                </div>
              )}
              {invalidDates && <ErrorNote face={face} message={t('text69')} />}
              {busy && <ListLoading t={say} />}
              {!result && !busy ? (
                <EmptyState t={say} filtered={false} title={t('text71')} hint={t('text72')} />
              ) : (
                result && (
                  <>
                    {renderTable ? (
                      renderTable(handle)
                    ) : (
                      <div className="table-scroll">
                        <table>
                          <caption className="sr-only">
                            {title}
                            {t('text73')}
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">{t('text75')}</th>
                              <th scope="col">{t('text60')}</th>
                              <th scope="col">{secondaryColumn ?? t('text78')}</th>
                              <th scope="col">{dateLabel}</th>
                              <RowOpenHeader t={say} />
                            </tr>
                          </thead>
                          <tbody>
                            {visibleRows.map(row => (
                              <tr key={row.id} {...writtenRowProps(say, written.has(row.id))}>
                                <td>
                                  <button
                                    className="record-link"
                                    data-row-id={row.id}
                                    onClick={_event => openRecord(row.id)}
                                  >
                                    {row.title}
                                  </button>
                                </td>
                                <td>
                                  <StatusPill tone={statusTone(row.status)}>
                                    {displayStatus(face.frame.t, row.status)}
                                  </StatusPill>
                                </td>
                                <td>{row.secondary || '—'}</td>
                                <td className="numeric">{row.date || '—'}</td>
                                <RowOpenCell
                                  face={face}
                                  title={row.title}
                                  onOpen={() => openRecord(row.id)}
                                  ask={resource ? { resource, id: row.id } : undefined}
                                />
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {(filtered.length === 0 || invalidDates) && (
                      <EmptyState
                        t={say}
                        filtered={Boolean(conditions)}
                        {...(conditions && !complete ? { hint: say('filtersLoadedOnlyHint') } : {})}
                      />
                    )}
                    <ListFooter
                      t={say}
                      count={shown}
                      partial={!complete}
                      page={currentPage}
                      pages={pages}
                      onPage={setPage}
                    />
                  </>
                )
              )}
            </section>
            <div className="data-caption">
              {result && (
                <>
                  <span>{caption}</span>
                  <time dateTime={result.executedAt}>
                    {t('text89')}
                    {formatDateTime(result.executedAt)}
                  </time>
                </>
              )}
            </div>
            <PreferenceDetails face={face} preferenceKey={`${operationId}:section3`} className="saved-queries">
              <summary>
                {t('text90')}
                {saved.length ? ` · ${saved.length}` : ''}
              </summary>
              <p>{t('text91')}</p>
              <div className="toolbar">
                <Input
                  aria-label={t('text92')}
                  placeholder={t('text93')}
                  value={label}
                  onChange={event => setLabel(event.target.value)}
                />
                <Button disabled={busy || saving || !result || !label.trim()} onClick={() => void save()}>
                  {t('text94')}
                </Button>
              </div>
              {saveMessage && <p role="status">{saveMessage}</p>}
              {saved.map(entry => (
                <div className="saved-entry" key={entry.id}>
                  <span>{entry.label}</span>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setFilter(emptyFilter)
                      setPage(1)
                      void load(entry.id)
                    }}
                  >
                    {t('text95')}
                  </Button>
                </div>
              ))}
            </PreferenceDetails>
          </>
        )}
      </div>
    </>
  )
}

/** The record's fields, as the operation returned them. */
export function RecordFields({ t, record }: { t: BusinessText; record: BusinessRow }): ReactNode {
  return (
    <dl className="detail-grid">
      <dt>{t('text50')}</dt>
      <dd>{record.id}</dd>
      {record.fields.map(([name, value]) => (
        <div className="detail-pair" key={name}>
          <dt>{name}</dt>
          <dd>{formatDisplayValue(value)}</dd>
        </div>
      ))}
    </dl>
  )
}
/** A link to the record in the ORYH console. */
export function OpenInConsole({
  t,
  connection,
  record,
}: {
  t: BusinessText
  connection: ConnectionSummary
  record: BusinessRow
}): ReactNode {
  return (
    <LinkButton
      href={`${connection.origin}/console/objects/${record.entityType}/${encodeURIComponent(record.id)}`}
      target="_blank"
      rel="noreferrer"
      icon={<IconArrowUpRight size={17} />}
    >
      {t('text52')}
    </LinkButton>
  )
}
