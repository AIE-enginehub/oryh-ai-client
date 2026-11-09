import {
  AskAi,
  BackToList,
  Button,
  ClearConditionsButton,
  displayField,
  displayStatus,
  displayStatusValue,
  EmptyState,
  ErrorNote,
  Field,
  formatDateTime,
  formatDisplayValue,
  Input,
  isStatusField,
  ListFooter,
  ListLoading,
  type PageContext,
  type PageFace,
  PageHeader,
  PreferenceDetails,
  pagePreference,
  productPreference,
  queryFieldsPreference,
  queryValuesPreference,
  RefreshButton,
  RowOpenCell,
  RowOpenHeader,
  StatusPill,
  statusTone,
  statusWords,
  textPreference,
  useCommand,
  useServerRefresh,
  useViewPreference,
  useViewSharing,
  useWrittenRecords,
  writtenRowProps,
} from '@oryh/ai-client-kit'
import type { BusinessRecord, ProductOption, RecordFilterField, RecordKind, RecordPage } from '@oryh/ai-client-records'
import { recordColumns, recordDefaultColumns, recordSpecs } from '@oryh/ai-client-records'
import type { UserViewSummary } from '@oryh/dsh-pane/types'
import { useEffect, useRef, useState } from 'react'
import type { RecordsApi } from './api.js'
import { recordPageLabels, rowName, sharedTitles } from './catalog.js'
import { RecordChildren } from './children.js'
import { ProductPicker } from './product-picker.js'
import type { WordKey, Words } from './words.js'

/** What each list's search box is labelled, as a key in this plugin's words. */
const queryLabels: Record<RecordKind, WordKey> = {
  'sales-orders': 'searchSalesOrders',
  'inventory-items': 'searchInventoryItems',
  'inventory-item-details': 'searchInventoryItemDetails',
  shipments: 'searchShipments',
}
/**
 * One ORYH list, either as a built-in page or as a menu entry the person made.
 *
 * A menu entry (`view`) is the same list narrowed by filters the SERVER applies. It keeps its own
 * paging and search so it never disturbs the plain list, and it reports the underlying list as the
 * page so the Host's permission check and the column tool treat it exactly like that list.
 */
export function RecordPanel({
  kind,
  active = true,
  view,
  columns,
  onColumns,
  api,
  face,
  t,
  onContext,
}: {
  active?: boolean
  view?: UserViewSummary
  columns: string[]
  onColumns: (columns: string[]) => void
  kind: RecordKind
  api: RecordsApi
  face: PageFace
  t: Words
  onContext: (value: PageContext) => void
}) {
  const connectionId = face.connection.id
  const catalog = recordColumns(kind)
  const text = face.frame.t,
    callback = useRef(onContext)
  callback.current = onContext
  const scope = view ? `view:${view.id}` : kind,
    listTitle = text(recordPageLabels[kind]),
    title = view?.label ?? listTitle,
    filterText = view
      ? Object.entries(view.filters)
          .map(([k, v]) => `${k} = ${v}`)
          .join(t('filterJoin'))
      : ''
  const [data, setData] = useState<RecordPage>(),
    [selected, setSelected] = useState<BusinessRecord>(),
    [page, setPage] = useViewPreference(face, `${scope}:page`, 1, pagePreference),
    [query, setQuery] = useViewPreference(face, `${scope}:query`, '', textPreference),
    [search, setSearch] = useViewPreference(face, `${scope}:search`, '', textPreference),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('')
  const selection = useRef(selected)
  selection.current = selected
  const [queryFields, setQueryFields] = useViewPreference<string[]>(
      face,
      `${scope}:queryFields`,
      [],
      queryFieldsPreference,
    ),
    [products, setProducts] = useViewPreference<ProductOption[]>(face, `${scope}:products`, [], productPreference),
    [appliedProducts, setAppliedProducts] = useViewPreference<ProductOption[]>(
      face,
      `${scope}:appliedProducts`,
      [],
      productPreference,
    )
  const [values, setValues] = useViewPreference<Record<string, string>>(
      face,
      `${scope}:queryValues`,
      {},
      queryValuesPreference,
    ),
    [appliedValues, setAppliedValues] = useViewPreference<Record<string, string>>(
      face,
      `${scope}:appliedQueryValues`,
      {},
      queryValuesPreference,
    )
  // What this list can be queried by is the deployment's answer, read from its own OpenAPI. Until it
  // arrives nothing extra is offered, and a saved field the endpoint no longer declares is dropped.
  const [declared, setDeclared] = useState<RecordFilterField[]>()
  useEffect(() => {
    if (view) {
      setDeclared([])
      return
    }
    let live = true
    setDeclared(undefined)
    void api.recordFilterFields(connectionId, kind).then(
      fields => {
        if (live) setDeclared(fields)
      },
      () => {
        if (live) setDeclared([])
      },
    )
    return () => {
      live = false
    }
  }, [api, connectionId, kind, view])
  const searchField = recordSpecs[kind].query
  // The search box already owns its field; product_code is a query this client composes for movements.
  const availableFields: { id: string; label: string; type: RecordFilterField['type'] | 'product' }[] = [
    ...(kind === 'inventory-item-details'
      ? [{ id: 'product_code', label: t('productField'), type: 'product' as const }]
      : []),
    ...(declared ?? [])
      .filter(f => f.name !== searchField)
      .map(f => ({ id: f.name, label: displayField(text, f.name, catalog[f.name] ?? f.name), type: f.type })),
  ]
  const shownFields =
    declared === undefined ? queryFields : queryFields.filter(id => availableFields.some(f => f.id === id))
  const activeValues = Object.fromEntries(
    Object.entries(appliedValues).filter(([id, value]) => value && id !== 'product_code' && shownFields.includes(id)),
  )
  const activeKey = JSON.stringify(activeValues)
  // After a write made in Chat the list re-reads in place: the rows stay on screen, and an open record
  // stays open with its new values instead of closing as a fresh query would.
  const softReload = useRef(false)
  const written = useWrittenRecords(face, kind)
  const sharing = useViewSharing(face, view)
  useServerRefresh(face, active, () => {
    softReload.current = true
    setReload(v => v + 1)
  })
  function configureFields(fields: string[]) {
    const keep = (v: Record<string, string>) =>
      Object.fromEntries(Object.entries(v).filter(([id]) => fields.includes(id)))
    setQueryFields(fields)
    setValues(keep(values))
    setAppliedValues(keep(appliedValues))
    if (!fields.includes('product_code')) {
      setProducts([])
      setAppliedProducts([])
    }
    setPage(1)
  }
  // The agent configures the query bar; a menu entry's filters are fixed, so it never applies there.
  useCommand(
    face,
    'navigation',
    kind,
    command => {
      if (!active || view || command.target !== 'filters') return false
      // Conditions with no fields named are those of a read the agent made in Chat (docs/56 §23): the
      // list shows the fields it has for them, beside those already there, and is queried by those
      // values alone. What this list is not queried by — or not yet known to be — is left out.
      if (command.queryFields === undefined) {
        if (declared === undefined) return false
        const known = Object.fromEntries(
          Object.entries(command.queryValues ?? {}).filter(([id]) => availableFields.some(f => f.id === id)),
        )
        setQueryFields([...new Set([...shownFields, ...Object.keys(known)])])
        setValues(known)
        setAppliedValues(known)
        setProducts([])
        setAppliedProducts([])
        // The list's own search box is one of ORYH's parameters too: a read by it is searched the same.
        const searched = (command.queryValues?.[searchField] ?? '').slice(0, 200)
        setQuery(searched)
        setSearch(searched)
        setPage(1)
        return true
      }
      configureFields(command.queryFields)
      if (command.queryValues !== undefined) {
        setValues(command.queryValues)
        setAppliedValues(command.queryValues)
      }
      if (command.products !== undefined) {
        setProducts(command.products)
        setAppliedProducts(command.products)
      }
      // No reload bump here: changed values or products already re-run the query through its dependencies,
      // and the extra counter sent the same request a second time.
      if (command.queryValues !== undefined || command.products !== undefined) {
        setSearch(query)
        setPage(1)
      }
      return true
    },
    [active, view, kind, declared, shownFields.join(',')],
  )
  // The agent opens one record by id — the order it just wrote, the one a todo points at. The list on
  // screen is a page of what its filters leave and usually does not hold it, so the record is read on its
  // own and shown as a row of this list would be. A menu entry's list is not this one's to answer for.
  const opening = useRef<string>(undefined)
  const [unopened, setUnopened] = useState<string>()
  useCommand(
    face,
    'navigation',
    kind,
    (command, issued) => {
      if (!active || view || command.target !== 'record' || !command.recordId) return false
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
      void api.recordGet(connectionId, kind, id).then(
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
    [active, view, kind, selected?.id, unopened, data],
  )
  useEffect(() => {
    let live = true
    const soft = softReload.current
    softReload.current = false
    if (!soft) {
      setBusy(true)
      setData(undefined)
      setSelected(undefined)
    }
    setError('')
    void api
      .recordList({
        connectionId,
        kind,
        page,
        query: search,
        ...(view
          ? { filters: view.filters }
          : {
              ...(kind === 'inventory-item-details' ? { productIds: appliedProducts.map(p => p.id) } : {}),
              ...(Object.keys(activeValues).length ? { filters: activeValues } : {}),
            }),
      })
      .then(async value => {
        if (live) {
          setData(value)
          if (page > Math.max(1, value.pages)) setPage(Math.max(1, value.pages))
          const id = soft ? selection.current?.id : undefined
          if (id) {
            try {
              const record = value.rows.find(row => row.id === id) ?? (await api.recordGet(connectionId, kind, id))
              if (live) setSelected(current => (current?.id === id ? record : current))
            } catch (cause) {
              if (live && selection.current?.id === id) {
                setSelected(undefined)
                setError(cause instanceof Error ? cause.message : t('recordNotRead'))
              }
            }
          }
        }
      })
      .catch(e => {
        if (live) setError(e instanceof Error ? e.message : t('listQueryFailed'))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [api, connectionId, kind, view, page, search, reload, appliedProducts, activeKey])
  useEffect(() => {
    callback.current({
      key: `${kind}:${selected?.id ?? 'list'}`,
      title: selected?.title ?? title,
      detail: filterText
        ? search
          ? t('contextFilteredSearch', { filters: filterText, search })
          : t('contextFiltered', { filters: filterText })
        : search || t('contextDefaultQuery'),
      scope: t(view ? 'contextScopeView' : appliedProducts.length ? 'contextScopeProducts' : 'contextScopePaged'),
      ...(view ? { view } : {}),
      queryFields: view ? Object.keys(view.filters) : shownFields,
      queryValues: view ? view.filters : activeValues,
      productIds: view ? [] : appliedProducts.map(p => p.id),
      columns,
      availableColumns: Object.entries(catalog).map(([id, label]) => ({ id, label })),
      content: JSON.stringify({
        loading: busy,
        error,
        page: data?.page ?? page,
        pages: data?.pages,
        total: data?.total,
        query: search,
        productIds: appliedProducts.map(p => p.id),
        queryDraft: { [searchField]: query, products, values },
        queryValues: view ? view.filters : activeValues,
        availableQueryFields: availableFields.map(({ id, label, type }) => ({ id, label, type })),
        fetchedAt: data?.fetchedAt,
        selected,
        visibleRows: selected ? [] : (data?.rows ?? []),
      }),
    })
  }, [
    kind,
    view,
    selected,
    busy,
    error,
    page,
    search,
    data,
    columns,
    queryFields,
    appliedProducts,
    query,
    products,
    values,
    activeKey,
    declared,
  ])
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
          title={title}
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
      {view && !selected && (
        <p className="data-caption">{t('viewCaption', { list: listTitle, filters: filterText })}</p>
      )}
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
                <dt>{displayField(text, f.field ?? '', f.label)}</dt>
                <dd>
                  {f.field !== undefined && isStatusField(f.field)
                    ? displayStatus(text, f.value)
                    : formatDisplayValue(f.value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {selected ? (
        <RecordChildren api={api} face={face} t={t} collection={kind} id={selected.id} />
      ) : (
        <>
          <section className="surface table-surface">
            <form
              className="record-search"
              onSubmit={e => {
                e.preventDefault()
                setPage(1)
                setSearch(query)
                setAppliedProducts(products)
                setAppliedValues(values)
                setReload(v => v + 1)
              }}
            >
              <Field label={t(queryLabels[kind])}>
                <Input value={query} onChange={event => setQuery(event.target.value)} maxLength={200} />
              </Field>
              {!view &&
                shownFields.map(id => {
                  const field = availableFields.find(f => f.id === id)
                  if (!field) return null
                  if (field.type === 'product')
                    return (
                      <Field key={id} label={t('fieldMultiple', { label: field.label })}>
                        <ProductPicker api={api} face={face} t={t} value={products} onChange={setProducts} />
                      </Field>
                    )
                  if (field.type === 'boolean')
                    return (
                      <Field key={id} label={field.label}>
                        <select value={values[id] ?? ''} onChange={e => setValues({ ...values, [id]: e.target.value })}>
                          <option value="">{t('booleanAll')}</option>
                          <option value="true">{t('booleanYes')}</option>
                          <option value="false">{t('booleanNo')}</option>
                        </select>
                      </Field>
                    )
                  // A state is typed and shown in the words the list shows it in; what goes to ORYH is its
                  // own value. A tenant's own state, which has no word here, is typed as it is.
                  if (isStatusField(id))
                    return (
                      <Field key={id} label={displayField(text, id, field.label)}>
                        <Input
                          value={displayStatus(text, values[id] ?? '')}
                          maxLength={200}
                          list={`${kind}-${id}-states`}
                          placeholder={t('statusPlaceholder')}
                          onChange={event =>
                            setValues({ ...values, [id]: displayStatusValue(text, event.target.value) })
                          }
                        />
                        <datalist id={`${kind}-${id}-states`}>
                          {Object.keys(statusWords).map(status => (
                            <option key={status} value={displayStatus(text, status)} />
                          ))}
                        </datalist>
                      </Field>
                    )
                  return (
                    <Field key={id} label={displayField(text, id, field.label)}>
                      <Input
                        value={values[id] ?? ''}
                        maxLength={200}
                        onChange={event => setValues({ ...values, [id]: event.target.value })}
                      />
                    </Field>
                  )
                })}
              <Button type="submit" disabled={busy}>
                {t('listQueryButton')}
              </Button>
              <ClearConditionsButton
                t={text}
                onClick={() => {
                  setQuery('')
                  setSearch('')
                  setProducts([])
                  setAppliedProducts([])
                  setValues({})
                  setAppliedValues({})
                  setPage(1)
                  setReload(v => v + 1)
                }}
              />
            </form>
            <div className="list-configuration">
              {!view && availableFields.length > 0 && (
                <PreferenceDetails face={face} preferenceKey={`${kind}:fieldsOpen`} className="advanced-filters">
                  <summary>{t('queryFieldsSummary')}</summary>
                  <div className="project-column-options">
                    {availableFields.map(f => (
                      <label key={f.id}>
                        <input
                          type="checkbox"
                          checked={queryFields.includes(f.id)}
                          onChange={e =>
                            configureFields(
                              e.target.checked ? [...queryFields, f.id] : queryFields.filter(x => x !== f.id),
                            )
                          }
                        />
                        {displayField(text, f.id, f.label)}
                      </label>
                    ))}
                  </div>
                </PreferenceDetails>
              )}
              <PreferenceDetails face={face} preferenceKey={`${scope}:columnsOpen`} className="advanced-filters">
                <summary>{t('columnsSummary')}</summary>
                <div className="project-column-options">
                  {Object.entries(catalog).map(([id, label]) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={columns.includes(id)}
                        disabled={columns.length === 1 && columns.includes(id)}
                        onChange={e => onColumns(e.target.checked ? [...columns, id] : columns.filter(c => c !== id))}
                      />
                      {displayField(text, id, label)}
                    </label>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => onColumns([...recordDefaultColumns[kind]])}>
                    {t('columnsReset')}
                  </Button>
                </div>
              </PreferenceDetails>
            </div>
            {kind === 'inventory-item-details' && <p className="data-caption">{t('movementsNote')}</p>}
            {busy ? (
              <ListLoading t={text} />
            ) : (
              data && (
                <div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {columns.map(c => (
                            <th scope="col" key={c}>
                              {displayField(text, c, catalog[c] ?? c)}
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
                              {columns.map((c, index) => (
                                <td key={c}>
                                  {index === 0 ? (
                                    <button className="record-link" onClick={() => setSelected(row)}>
                                      {cell(c)}
                                    </button>
                                  ) : c === 'status' && cell(c) !== '—' ? (
                                    <StatusPill tone={statusTone(cell(c))}>{displayStatus(text, cell(c))}</StatusPill>
                                  ) : (
                                    cell(c)
                                  )}
                                </td>
                              ))}
                              <RowOpenCell
                                face={face}
                                title={rowName(
                                  row,
                                  columns.map(c => cell(c)),
                                  shared,
                                )}
                                onOpen={() => setSelected(row)}
                                ask={{ resource: kind, id: row.id }}
                              />
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {!data.rows.length && (
                    <EmptyState
                      t={text}
                      filtered={Boolean(search || view || Object.keys(activeValues).length || appliedProducts.length)}
                    />
                  )}
                  <ListFooter t={text} count={data.total} page={page} pages={data.pages} onPage={setPage} />
                </div>
              )
            )}
          </section>
        </>
      )}
    </section>
  )
}
