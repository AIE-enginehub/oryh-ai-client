/**
 * A menu entry over an ORYH collection this client ships no page for.
 *
 * The built-in lists (`RecordPanel`) know their own columns, their search field and, for movements,
 * how to resolve products. An entry a person made through Chat knows none of that: it carries the
 * collection, the filters the server applies, and the columns it was made with. So it shows the same
 * surfaces from the frame's list kit — header, table, pagination, record detail — over what it holds,
 * and nothing it does not: no search box, because a collection has no field this client knows to
 * search, and no query builder, because the entry IS the query.
 */

import {
  AskAi,
  BackToList,
  displayField,
  displayStatus,
  EmptyState,
  ErrorNote,
  fieldLabel,
  formatDateTime,
  formatDisplayValue,
  isStatusField,
  ListFooter,
  ListLoading,
  type PageContext,
  type PageFace,
  PageHeader,
  PreferenceDetails,
  pagePreference,
  RefreshButton,
  RowOpenCell,
  RowOpenHeader,
  StatusPill,
  statusTone,
  useCommand,
  useServerRefresh,
  useViewPreference,
  useViewSharing,
  useWrittenRecords,
  writtenRowProps,
} from '@oryh/ai-client-kit'
import type { BusinessRecord, RecordPage } from '@oryh/ai-client-records'
import type { UserViewSummary } from '@oryh/dsh-pane/types'
import { useEffect, useRef, useState } from 'react'
import type { RecordsApi } from './api.js'
import { rowName, sharedTitles } from './catalog.js'
import { RecordChildren } from './children.js'
import type { Words } from './words.js'

/** One page of a collection, as the entry that names it says to show it. */
export function CollectionPanel({
  view,
  active = true,
  columns,
  onColumns,
  api,
  face,
  t,
  onContext,
}: {
  view: UserViewSummary
  active?: boolean
  columns: string[]
  onColumns: (columns: string[]) => void
  api: RecordsApi
  face: PageFace
  t: Words
  onContext: (value: PageContext) => void
}) {
  const connectionId = face.connection.id
  const text = face.frame.t
  const callback = useRef(onContext)
  callback.current = onContext
  const scope = `view:${view.id}`
  const catalog = Object.fromEntries((view.display?.columns ?? []).map(c => [c.field, c.label]))
  const shown = columns.filter(c => Object.hasOwn(catalog, c))
  // Said as the entry's own columns name them, then as the workbench does: 状态：待处理, not status = open.
  const filterText = Object.entries(view.filters)
    .map(([k, v]) =>
      t('filterLabelled', {
        label: displayField(text, k, catalog[k] ?? fieldLabel(k)),
        value: isStatusField(k) ? displayStatus(text, v) : v,
      }),
    )
    .join(t('filterJoin'))
  // The entry's collection and what narrows it: the caption under its title, and what Chat reads of it.
  const caption = filterText ? t('viewCaption', { list: view.collection, filters: filterText }) : view.collection
  const [data, setData] = useState<RecordPage>(),
    [selected, setSelected] = useState<BusinessRecord>(),
    [page, setPage] = useViewPreference(face, `${scope}:page`, 1, pagePreference),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('')
  const selection = useRef(selected)
  selection.current = selected
  useServerRefresh(face, active, () => setReload(v => v + 1))
  const written = useWrittenRecords(face, view.collection)
  const sharing = useViewSharing(face, view)
  useEffect(() => {
    if (!active) return
    let live = true
    setBusy(true)
    setError('')
    api
      .collectionList({
        connectionId,
        collection: view.collection,
        page,
        filters: view.filters,
        display: view.display ?? { columns: [] },
      })
      .then(
        async result => {
          if (!live) return
          setData(result)
          // Keep an open record in step with the list: the agent may have written it since it was opened.
          const id = selection.current?.id
          if (id) {
            try {
              // A submit can move the record out of this filter or page. Read it by id rather than
              // keeping the snapshot from before the write; ORYH checks access again on that read.
              const record =
                result.rows.find(row => row.id === id) ??
                (await api.collectionGet({
                  connectionId,
                  collection: view.collection,
                  id,
                  display: view.display ?? { columns: [] },
                }))
              if (live) setSelected(current => (current?.id === id ? record : current))
            } catch (cause) {
              if (live && selection.current?.id === id) {
                setSelected(undefined)
                setError(cause instanceof Error ? cause.message : t('recordNotRead'))
              }
            }
          }
          if (live) setBusy(false)
        },
        (cause: unknown) => {
          if (!live) return
          setError(cause instanceof Error ? cause.message : t('collectionReadFailed'))
          setBusy(false)
        },
      )
    return () => {
      live = false
    }
  }, [active, api, connectionId, page, reload, view.collection, view.filters, view.display])
  // The agent, or a link in a Chat answer, opens one record of this entry's collection by id. The entry
  // shows a page of what its filters leave, so the record is read by itself and shown as a row would be.
  // A command for another entry is that entry's to answer, once the workbench has got there.
  const opening = useRef<string>(undefined)
  const [unopened, setUnopened] = useState<string>()
  useCommand(
    face,
    'navigation',
    'collection',
    (command, issued) => {
      if (!active || command.target !== 'record' || !command.recordId) return false
      if (command.userViewId !== undefined && command.userViewId !== view.id) return false
      const id = command.recordId
      if (selected?.id === id) return true
      // Read and refused: acknowledged, with the reason on the page and in what Chat reads of it.
      if (unopened === issued.id) return true
      const row = data?.rows.find(candidate => candidate.id === id)
      if (row) {
        setSelected(row)
        return false
      }
      if (opening.current === issued.id) return false
      opening.current = issued.id
      void api
        .collectionGet({ connectionId, collection: view.collection, id, display: view.display ?? { columns: [] } })
        .then(
          record => {
            if (opening.current !== issued.id) return
            opening.current = undefined
            setSelected(record)
          },
          (reason: unknown) => {
            if (opening.current !== issued.id) return
            opening.current = undefined
            setError(reason instanceof Error ? reason.message : t('recordNotRead'))
            setUnopened(issued.id)
          },
        )
      return false
    },
    [active, view.id, view.collection, selected?.id, unopened, data],
  )
  // What the agent reads as the live page: the entry, what narrows it, and the rows on screen.
  useEffect(() => {
    if (!active) return
    callback.current({
      key: `collection:${selected?.id ?? 'list'}`,
      title: selected?.title ?? view.label,
      detail: caption,
      scope: t('contextScopeView'),
      view,
      queryFields: Object.keys(view.filters),
      queryValues: view.filters,
      columns: shown,
      availableColumns: Object.entries(catalog).map(([id, label]) => ({ id, label })),
      content: JSON.stringify({
        loading: busy,
        error,
        collection: view.collection,
        page: data?.page ?? page,
        pages: data?.pages,
        total: data?.total,
        queryValues: view.filters,
        fetchedAt: data?.fetchedAt,
        selected,
        visibleRows: selected ? [] : (data?.rows ?? []),
      }),
    })
  }, [active, busy, catalog, data, error, caption, page, selected, shown, view])
  return (
    <section className="business-page oryh-records" aria-busy={busy}>
      {selected ? (
        <PageHeader
          back={<BackToList t={text} onClick={() => setSelected(undefined)} />}
          title={selected.title}
          actions={<AskAi face={face} question={text('askRecordQuestion')} />}
        />
      ) : (
        <PageHeader
          title={view.label}
          {...(sharing.note ? { note: sharing.note } : {})}
          actions={
            <>
              {sharing.action}
              <RefreshButton t={text} disabled={busy} onClick={() => setReload(v => v + 1)} />
            </>
          }
        />
      )}
      {!selected && sharing.error}
      {!selected && <p className="data-caption">{caption}</p>}
      {error && <ErrorNote face={face} message={error} disabled={busy} onRetry={() => setReload(v => v + 1)} />}
      {selected ? (
        <div className="surface document-detail">
          <h2>{t('detailTitle')}</h2>
          <p className="data-caption">
            {t('detailSource', { time: data?.fetchedAt ? formatDateTime(data.fetchedAt) : '' })}
          </p>
          <dl className="document-fields">
            {selected.fields.map(f => (
              <div key={f.field ?? f.label}>
                <dt>{displayField(face.frame.t, f.field ?? '', f.label)}</dt>
                {/* A state reads here as it does in the list beside it. */}
                <dd>
                  {f.field !== undefined && isStatusField(f.field)
                    ? displayStatus(face.frame.t, f.value)
                    : formatDisplayValue(f.value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {selected ? (
        <RecordChildren api={api} face={face} t={t} collection={view.collection} id={selected.id} />
      ) : (
        <section className="surface table-surface">
          <div className="list-configuration">
            <PreferenceDetails face={face} preferenceKey={`${scope}:columnsOpen`} className="advanced-filters">
              <summary>{t('columnsSummary')}</summary>
              <div className="project-column-options">
                {Object.entries(catalog).map(([id, label]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={shown.includes(id)}
                      disabled={shown.length === 1 && shown.includes(id)}
                      onChange={e => onColumns(e.target.checked ? [...shown, id] : shown.filter(c => c !== id))}
                    />
                    {displayField(face.frame.t, id, label)}
                  </label>
                ))}
              </div>
            </PreferenceDetails>
          </div>
          {busy ? (
            <ListLoading t={text} />
          ) : (
            data && (
              <div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {shown.map(c => (
                          <th scope="col" key={c}>
                            {displayField(face.frame.t, c, catalog[c]!)}
                          </th>
                        ))}
                        <RowOpenHeader t={text} />
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(row => {
                        const shared = sharedTitles(data.rows)
                        const cell = (c: string) =>
                          formatDisplayValue(row.fields.find(f => f.field === c)?.value ?? '—')
                        return (
                          <tr key={row.id} {...writtenRowProps(text, written.has(row.id))}>
                            {shown.map((c, index) => (
                              <td key={c}>
                                {index === 0 ? (
                                  <button className="record-link" onClick={() => setSelected(row)}>
                                    {cell(c)}
                                  </button>
                                ) : c === 'status' && cell(c) !== '—' ? (
                                  <StatusPill tone={statusTone(cell(c))}>
                                    {displayStatus(face.frame.t, cell(c))}
                                  </StatusPill>
                                ) : (
                                  cell(c)
                                )}
                              </td>
                            ))}
                            <RowOpenCell
                              face={face}
                              title={rowName(
                                row,
                                shown.map(c => cell(c)),
                                shared,
                              )}
                              onOpen={() => setSelected(row)}
                              ask={{ resource: view.collection, id: row.id }}
                            />
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {!data.rows.length && <EmptyState t={text} filtered={Boolean(filterText)} />}
                <ListFooter t={text} count={data.total} page={page} pages={data.pages} onPage={setPage} />
              </div>
            )
          )}
        </section>
      )}
    </section>
  )
}
