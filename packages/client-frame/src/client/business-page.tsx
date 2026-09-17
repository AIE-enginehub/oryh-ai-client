import { Button, Field, Input, MessageBar, MessageBarBody, Select } from '@fluentui/react-components'
import type { ConnectionSummary, OperationId, OryhOperationResult, SavedOperationView } from '@oryh/ai-client-core'
import type { PaneContext } from '@oryh/dsh-pane/types'
import { IconArrowUpRight, IconSearch } from '@tabler/icons-react'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { type BusinessRow, businessRows, emptyFilter, filterRows, type ViewFilter } from './business-data.js'
import {
  BackToList,
  ClearConditionsButton,
  EmptyState,
  ErrorNote,
  formatDateTime,
  formatDisplayValue,
  ListFooter,
  ListLoading,
  PageHeader,
  RefreshButton,
  RowOpenCell,
  RowOpenHeader,
  StatusPill,
} from './list-kit.js'
import { useBusinessText } from './locale.js'
import { useServerRefresh } from './pane.js'
import { useOryhRemote } from './remote.js'
import { statusLabel, statusTone } from './status-words.js'
import { filterPreference, PreferenceDetails, pagePreference, useViewPreference } from './view-preferences.js'

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
const ListHandleContext = createContext<ListHandle | undefined>(undefined)
/** The enclosing operation list; for components a page plugin renders inside {@link BusinessPage}. */
export function useListHandle(): ListHandle {
  const handle = useContext(ListHandleContext)
  if (!handle) throw new Error('useListHandle is only valid inside BusinessPage')
  return handle
}

/**
 * One fixed ORYH read operation as a page: its rows, filters, paging, saved views and the open record.
 *
 * The page plugins compose it: a different table, extra filters, extra actions, a richer detail, and
 * whatever their page adds to the context the Host reads. Nothing here knows which operation it is.
 */
export function BusinessPage({
  connection,
  operationId,
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
  children,
}: {
  connection: ConnectionSummary
  operationId: OperationId
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
  /** Rendered beside the list with the list handle in context: bridges, chat panels. */
  children?: ReactNode
}): ReactNode {
  const t = useBusinessText()
  const remote = useOryhRemote()
  const [result, setResult] = useState<OryhOperationResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useViewPreference<ViewFilter>(`${operationId}:filter`, emptyFilter, filterPreference)
  const [page, setPage] = useViewPreference(`${operationId}:page`, 1, pagePreference)
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
  const rows = useMemo(() => (result ? businessRows(result, t) : []), [result, t])
  const filtered = useMemo(() => filterRows(rows, filter), [rows, filter])
  const selected = rows.find(row => row.id === selectedId)
  const pages = Math.max(1, Math.ceil(filtered.length / 12))
  const currentPage = Math.min(page, pages)
  const dateLabel = dateLabelProp ?? t('text30')
  const invalidDates = Boolean(filter.from && filter.to && filter.from > filter.to)
  const conditions = [
    filter.text && t('text31', { value0: filter.text }),
    filter.status && t('text32', { value0: statusLabel(filter.status) }),
    filter.from && t('text33', { value0: dateLabel, value1: filter.from }),
    filter.to && t('text34', { value0: filter.to }),
  ]
    .filter(Boolean)
    .join(' · ')
  const total = result?.result.meta.total
  // Filtering happens in the browser, so a count is only a total when every server row was loaded.
  const complete = total !== null && total !== undefined && rows.length >= total
  const scope = t('text37', {
    value0: rows.length,
    value1: total !== null && total !== undefined ? t('text35', { value0: total }) : t('text36'),
  })
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
      ...extra,
      content: JSON.stringify({
        loading: busy,
        error,
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
  // Rows are matched by id, so an open record stays open across the re-read and shows its new state.
  useServerRefresh(active, () => {
    if (loaded.current) void load()
  })
  function update(patch: Partial<ViewFilter>) {
    setFilter(current => ({ ...current, ...patch }))
    setPage(1)
  }
  async function save() {
    if (!result || running.current || !label.trim()) return
    running.current = true
    setBusy(true)
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
      if (alive.current) setBusy(false)
    }
  }
  return (
    <ListHandleContext.Provider value={handle}>
      <div ref={root} className="business-page">
        {selected ? (
          <PageHeader
            back={<BackToList onClick={returnToList} />}
            title={selected.title}
            status={<StatusPill tone={statusTone(selected.status)}>{statusLabel(selected.status)}</StatusPill>}
          />
        ) : (
          <PageHeader
            title={title}
            tabs={tabs}
            actions={
              <>
                <RefreshButton disabled={busy} onClick={() => void load()} />
                {actions}
              </>
            }
          />
        )}
        {error && (
          <ErrorNote
            message={
              <>
                {error} {result && t('text47')}
              </>
            }
            disabled={busy}
            onRetry={() => void load()}
          />
        )}
        {children}
        {selected ? (
          <section className="surface record-detail">
            {renderDetail ? (
              renderDetail(handle)
            ) : (
              <>
                <RecordFields record={selected} />
                <p className="muted">{t('text51')}</p>
                <OpenInConsole connection={connection} record={selected} />
              </>
            )}
          </section>
        ) : (
          <>
            {selectedId && !selected && (
              <MessageBar>
                <MessageBarBody>{t('text53')}</MessageBarBody>
              </MessageBar>
            )}
            <section className="surface table-surface" aria-label={title}>
              <div className="query-toolbar">
                <Field label={t('text58')}>
                  <Input
                    contentBefore={<IconSearch size={16} />}
                    placeholder={t('text59')}
                    value={filter.text}
                    onChange={(_, data) => update({ text: data.value })}
                  />
                </Field>
                <Field label={t('text60')}>
                  <Select value={filter.status} onChange={event => update({ status: event.target.value })}>
                    <option value="">{t('text61')}</option>
                    {[...new Set([...rows.map(row => row.status), ...(filter.status ? [filter.status] : [])])].map(
                      status => (
                        <option key={status} value={status}>
                          {statusLabel(status)}
                        </option>
                      ),
                    )}
                  </Select>
                </Field>
              </div>
              <PreferenceDetails preferenceKey={`${operationId}:section1`} className="advanced-filters">
                <summary>更多筛选与排序{filter.from || filter.to || !filter.descending ? ' · 已设置' : ''}</summary>
                <div className="advanced-filter-fields">
                  <Field label={t('text62', { value0: dateLabel })}>
                    <Input type="date" value={filter.from} onChange={(_, data) => update({ from: data.value })} />
                  </Field>
                  <Field label={t('text63')}>
                    <Input type="date" value={filter.to} onChange={(_, data) => update({ to: data.value })} />
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
                    onClick={() => {
                      setFilter(emptyFilter)
                      setPage(1)
                    }}
                  />
                </div>
              )}
              {invalidDates && <ErrorNote message={t('text69')} />}
              {busy && <ListLoading />}
              {!result && !busy ? (
                <EmptyState filtered={false} title={t('text71')} hint={t('text72')} />
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
                              <RowOpenHeader />
                            </tr>
                          </thead>
                          <tbody>
                            {visibleRows.map(row => (
                              <tr key={row.id}>
                                <td>
                                  <button
                                    className="record-link"
                                    data-row-id={row.id}
                                    onClick={event => openRecord(row.id)}
                                  >
                                    {row.title}
                                  </button>
                                </td>
                                <td>
                                  <StatusPill tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusPill>
                                </td>
                                <td>{row.secondary || '—'}</td>
                                <td className="numeric">{row.date || '—'}</td>
                                <RowOpenCell title={row.title} onOpen={() => openRecord(row.id)} />
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {(filtered.length === 0 || invalidDates) && (
                      <EmptyState
                        filtered={Boolean(conditions)}
                        {...(conditions && !complete
                          ? { hint: '筛选只作用于本次载入的记录；调整或清空筛选条件后再看。' }
                          : {})}
                      />
                    )}
                    <ListFooter
                      count={invalidDates ? 0 : filtered.length}
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
              <span>{scope}</span>
              {result && (
                <time dateTime={result.executedAt}>
                  {t('text89')}
                  {formatDateTime(result.executedAt)}
                </time>
              )}
            </div>
            <PreferenceDetails preferenceKey={`${operationId}:section3`} className="saved-queries">
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
                  onChange={(_, data) => setLabel(data.value)}
                />
                <Button disabled={busy || !result || !label.trim()} onClick={() => void save()}>
                  {t('text94')}
                </Button>
              </div>
              {saveMessage && <p role="status">{saveMessage}</p>}
              {saved.map(entry => (
                <div className="saved-entry" key={entry.id}>
                  <span>{entry.label}</span>
                  <Button
                    size="small"
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
    </ListHandleContext.Provider>
  )
}

/** The record's fields, as the operation returned them. */
export function RecordFields({ record }: { record: BusinessRow }): ReactNode {
  const t = useBusinessText()
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
  connection,
  record,
}: {
  connection: ConnectionSummary
  record: BusinessRow
}): ReactNode {
  const t = useBusinessText()
  return (
    <Button
      as="a"
      href={`${connection.origin}/console/objects/${record.entityType}/${encodeURIComponent(record.id)}`}
      target="_blank"
      rel="noreferrer"
      icon={<IconArrowUpRight size={17} />}
    >
      {t('text52')}
    </Button>
  )
}
