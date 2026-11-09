import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { defineStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BackToList,
  type BridgeOwnerProps,
  Button,
  columnPreferenceScope,
  Dialog,
  DraftLeaveDialog,
  displayField,
  ErrorNote,
  formatDateTime,
  ListLoading,
  type PageFace,
  PageHeader,
  type PageOwnerProps,
  RefreshButton,
  unwrap,
  useBeforeUnload,
  useCommand,
  usePane,
  userViewPage,
} from '@oryh/ai-client-kit'
import { canAccessPage } from '@oryh/ai-client-pages'
import { recordColumns } from '@oryh/ai-client-records'
import {
  type AnalysisApi,
  type AnalysisDefinition,
  type AnalysisDocument,
  type AnalysisResult,
  type AnalysisSection,
  aggregate,
  changeSection,
  defaultDefinition,
  groupId,
  sources,
  sourceTitlesEn,
} from '@oryh/dsh-analytics/model'
import { TYPERT_REMOTE } from '@oryh/dsh-analytics/remote'
import type {} from '@oryh/dsh-client-frame/client'
import { IconChartBar, IconReportAnalytics } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { CHAT_FORM_KIND, chatFormDefinition } from './chat-form.js'
import { ChatForms, type ChatFormsInjected } from './chat-form-view.js'
import { type CustomApi, CustomPageOwner, createCustomApi } from './custom-page.js'
import { english } from './en.js'
import styles from './styles.css'
import { type WordKey, type Words, words } from './words.js'

/** A built-in analysis source in the frame's language, by the source id rather than its Chinese title. */
function displaySource(t: PageFace['frame']['t'], source: string | undefined, fallback = ''): string {
  const fromSource = source === undefined ? undefined : sources[source as keyof typeof sources]?.title
  const title = fromSource ?? (fallback || source || '')
  return t('interfaceLanguage') === 'en' ? (sourceTitlesEn[source ?? ''] ?? title) : title
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    oryhAnalytics: WordKey
  }
}

function CustomPageList({
  face,
  t,
  api,
  request,
  ready,
  active,
}: {
  face: PageFace
  t: Words
  api: CustomApi
  request: { sessionId: string; connectionId: string }
  ready: boolean
  active: boolean
}) {
  const { navigate } = face.frame
  const { views, loaded: menuLoaded } = face.frame.menu
  const [pages, setPages] = useState<Awaited<ReturnType<CustomApi['list']>>>([])
  const [error, setError] = useState('')
  const [runningId, setRunningId] = useState('')
  const [migration, setMigration] = useState<Awaited<ReturnType<CustomApi['migrate']>>>()
  // The page asked to be deleted, while the person is asked whether they mean it.
  const [deleting, setDeleting] = useState<(typeof pages)[number]>()
  const remove = (page: (typeof pages)[number]) => {
    setDeleting(undefined)
    setRunningId(page.id)
    setError('')
    void api
      .delete({ ...request, id: page.id, expectedVersion: page.version })
      .then(() => setPages(current => current.filter(item => item.id !== page.id)))
      .catch(reason => setError(reason instanceof Error ? reason.message : t('customDeleteFailed')))
      .finally(() => setRunningId(''))
  }
  useEffect(() => {
    if (!ready || !active) return
    let alive = true
    void api.list(request).then(
      value => {
        if (alive) setPages(value)
      },
      reason => {
        if (alive) setError(reason instanceof Error ? reason.message : t('customListLoadFailed'))
      },
    )
    return () => {
      alive = false
    }
  }, [api, request.sessionId, request.connectionId, ready, active])
  return (
    <div>
      <h2>{t('customListTitle')}</h2>
      {error && <ErrorNote face={face} message={error} />}
      <Dialog
        open={deleting !== undefined}
        onClose={() => setDeleting(undefined)}
        title={t('customDeleteTitle')}
        closeLabel={face.frame.t('dialogClose')}
        actions={
          <>
            <Button onClick={() => setDeleting(undefined)}>{t('customDeleteCancel')}</Button>
            <Button variant="primary" onClick={() => deleting && remove(deleting)}>
              {t('customDeleteConfirmButton')}
            </Button>
          </>
        }
      >
        <p>{t('customDeleteConfirm', { title: deleting?.title ?? '' })}</p>
      </Dialog>
      <p>
        <Button
          disabled={!!runningId}
          onClick={() => {
            setRunningId('migrate')
            setError('')
            void api
              .migrate(request)
              .then(async report => {
                setMigration(report)
                setPages(await api.list(request))
              })
              .catch(reason => setError(reason instanceof Error ? reason.message : t('customListMigrateFailed')))
              .finally(() => setRunningId(''))
          }}
        >
          {runningId === 'migrate' ? t('customListMigrating') : t('customListMigrate')}
        </Button>{' '}
        <small className="muted">{t('customListMigrateHint')}</small>
      </p>
      {migration && (
        <div role="status" className="muted">
          <p>
            {t('customListMigrationSummary', {
              migrated: migration.migrated.length,
              existing: migration.existing.length,
              failed: migration.failed.length,
            })}
          </p>
          <ul>
            {migration.migrated.map(item => (
              <li key={item.from}>
                {item.notes.length
                  ? t('customListMigratedNotes', {
                      title: item.title,
                      notes: item.notes.join(t('customListNoteJoin')),
                    })
                  : item.title}
              </li>
            ))}
            {migration.failed.map(item => (
              <li key={item.from}>{t('customListNotMigrated', { title: item.title, error: item.error })}</li>
            ))}
          </ul>
        </div>
      )}
      {!pages.length && <p className="muted">{t('customListEmpty')}</p>}
      {pages.map(page => {
        const published = views.some(view => view.id === page.id)
        return (
          <div className="analysis-document" key={page.id}>
            <strong>{page.title}</strong>
            <small>
              {!page.available
                ? t('customListUnavailable')
                : page.latest?.version === page.version
                  ? t('customGeneratedAt', { time: formatDateTime(page.latest.endedAt ?? page.latest.startedAt) })
                  : page.run?.status === 'failed'
                    ? t('customListLastFailed', { error: page.run.error ?? t('customListRunFailed') })
                    : t('customListWaiting')}
            </small>
            {!page.available ? (
              <Button disabled={!!runningId} onClick={() => setDeleting(page)}>
                {t('customDelete')}
              </Button>
            ) : !menuLoaded ? (
              <Button disabled>{t('customListSyncingMenu')}</Button>
            ) : published ? (
              <Button onClick={() => navigate(userViewPage(page.id))}>{t('customListOpen')}</Button>
            ) : (
              <Button
                disabled={!!runningId}
                onClick={() => {
                  setRunningId(page.id)
                  setError('')
                  void api
                    .run({ ...request, id: page.id, expectedVersion: page.version })
                    .then(
                      async () => setPages(await api.list(request)),
                      reason => setError(reason instanceof Error ? reason.message : t('customListFirstRunFailed')),
                    )
                    .finally(() => setRunningId(''))
                }}
              >
                {runningId === page.id ? t('customListRunning') : t('customListFirstRun')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

const selectionStore = defineStore({
  init: () => ({ id: '', request: 0, dirty: false }),
  persist: 'oryh.analysis.selection.v1',
  actions: {
    open: (d, id: string) => {
      d.id = id
      d.request++
      d.dirty = false
    },
    dirty: (d, value: boolean) => {
      d.dirty = value
    },
  },
})
interface Selection {
  id: string
  request: number
  dirty: boolean
}
const NOTHING_OPEN: Selection = { id: '', request: 0, dirty: false }
/**
 * The analysis each session has open, by connection and session: held outside the components, so it is
 * still open when its page is drawn again.
 * @returns the source the slot's `useSelection` is made from, and the ways to change what it holds.
 */
export function createSelections() {
  const stores = new Map<string, ReturnType<typeof selectionStore.create>>()
  const of = (scope: string) => {
    let store = stores.get(scope)
    if (!store) {
      store = selectionStore.create(scope)
      store.actions.dirty(false)
      stores.set(scope, store)
    }
    return store
  }
  return {
    source: (scope: string): ObservableSnapshot<Selection> => of(scope),
    open: (scope: string, id: string) => of(scope).actions.open(id),
    setDirty: (scope: string, dirty: boolean) => of(scope).actions.dirty(dirty),
    dirty: (scope: string) => of(scope).getSnapshot().dirty,
  }
}
/** What the analysis page is given of the selections, beside what the frame's slot gives every page. */
export interface SelectionInjected {
  keyedHooks: { selection: (scope: string) => ObservableSnapshot<Selection> }
  openAnalysis(scope: string, id: string): void
  setDirty(scope: string, dirty: boolean): void
}
/** What the bridge is given of them: it opens an analysis Chat names, unless one is being edited. */
interface BridgeInjected {
  analysisDirty(scope: string): boolean
  openAnalysis(scope: string, id: string): void
}
type AnalysisProps = PageOwnerProps &
  InjectFace<SelectionInjected> & { face: PageFace; t: Words; api: AnalysisApi; customApi?: CustomApi }
function key(connection: PageOwnerProps['connection'], sessionId: string) {
  return `${columnPreferenceScope(connection)}:${sessionId}`
}
function AnalysisBridge({
  connection,
  navigate,
  face,
  analysisDirty,
  openAnalysis,
}: BridgeOwnerProps & BridgeInjected & { face: PageFace }) {
  const { sessionId } = face.frame
  useCommand(
    face,
    'navigation',
    undefined,
    command => {
      if (command.target !== 'analysis' || !command.analysisId || !sessionId) return false
      const scope = key(connection, sessionId)
      if (analysisDirty(scope)) return false
      openAnalysis(scope, command.analysisId)
      navigate('analytics', command.reveal === true)
      return true
    },
    [connection, sessionId, navigate],
  )
  return null
}
export function createAnalysisApi(remote: ClientRemote): AnalysisApi {
  const api = remote.oryhAnalytics
  return {
    list: r => unwrap(api.list(r)),
    load: r => unwrap(api.load(r)),
    preview: r => unwrap(api.preview(r)),
    save: r => unwrap(api.save(r)),
  }
}
export const inject = ['slots', 'remote', 'locale', 'oryhClientPages', 'sessions', 'uiConversation']
export async function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('oryhAnalytics', { zh: words, en: english }), 'oryh analytics locale')
  ctx.effect(() => {
    const sheet = document.createElement('style')
    sheet.textContent = styles
    document.head.append(sheet)
    return () => sheet.remove()
  }, 'oryh analytics styles')
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryhAnalytics'], ctx => {
    const api = createAnalysisApi(ctx.remote)
    const customApi = createCustomApi(ctx.remote, () => ctx.locale.getSnapshot().active)
    // Kept here, outside any component: an analysis stays open while its page is drawn again.
    const selections = createSelections()
    ctx.effect(
      () =>
        ctx.oryhClientPages.register({
          page: 'analytics',
          order: 60,
          group: 'insights',
          icon: IconReportAnalytics,
          label: () => ctx.locale.bind('oryhAnalytics')('pageTitle'),
        }),
      'oryh analytics menu',
    )
    ctx.slots.inject('oryh.page', () =>
      ctx.slots.register(
        {
          name: 'oryh.page',
          key: 'analytics',
          locale: 'oryhAnalytics',
          inject: (): SelectionInjected => ({
            keyedHooks: { selection: selections.source },
            openAnalysis: selections.open,
            setDirty: selections.setDirty,
          }),
        },
        props =>
          props.view?.collection === 'custom-pages' ? (
            <CustomPageOwner {...props} face={props} t={props.t} api={customApi} />
          ) : (
            <AnalysisOwner {...props} face={props} t={props.t} api={api} customApi={customApi} />
          ),
      ),
    )
    ctx.slots.inject('oryh.bridge', () =>
      ctx.slots.register(
        {
          name: 'oryh.bridge',
          id: 'analytics',
          locale: 'oryhAnalytics',
          inject: (): BridgeInjected => ({ analysisDirty: selections.dirty, openAnalysis: selections.open }),
        },
        props => <AnalysisBridge {...props} face={props} />,
      ),
    )
    // Forms the agent puts in the conversation: read from the session's record, drawn under the answer of
    // the turn that showed them, and handed back as the person's next message (chat-form.ts).
    ctx.effect(() => ctx.uiConversation.events.register(chatFormDefinition), 'oryh chat forms')
    ctx.slots.inject('conversation.chat.turnTail', () =>
      ctx.slots.register(
        {
          name: 'conversation.chat.turnTail',
          id: '@oryh/dsh-client-analytics:chat-form',
          // The forms have no `face`: every word they say, the dialog's close label too, is this plugin's.
          locale: 'oryhAnalytics',
          inject: (sessionId): ChatFormsInjected => {
            const binding = ctx.sessions.binding(sessionId)
            if (binding === undefined) throw new Error(`oryh chat forms: unknown session "${sessionId}"`)
            const chat = ctx.uiConversation.binding(binding).target('chat')
            return {
              keyedHooks: {
                forms: turn => {
                  const snapshot = chat.getSnapshot()
                  if (snapshot === undefined) throw new Error('oryh chat forms: the Chat target is unavailable')
                  return snapshot.nodes.turnDataSource(Number(turn), CHAT_FORM_KIND)
                },
              },
              records: (lookup, query, page) =>
                unwrap(
                  ctx.remote.oryhAnalytics.chatFormRecords({
                    sessionId: String(sessionId),
                    collection: lookup.collection,
                    label: lookup.label,
                    ...(lookup.code ? { code: lookup.code } : {}),
                    query,
                    page,
                  }),
                ),
              submit: async (form, values) =>
                (
                  await unwrap(
                    ctx.remote.oryhAnalytics.chatFormSubmit({
                      sessionId: String(sessionId),
                      language: ctx.locale.getSnapshot().active,
                      callId: form.callId,
                      definitionJson: form.definitionJson,
                      valuesJson: JSON.stringify(values),
                    }),
                  )
                ).message,
            }
          },
        },
        ChatForms,
      ),
    )
  })
}
function AnalysisOwner(props: AnalysisProps) {
  const pane = usePane(props.face)
  const { sessionId } = props.face.frame
  return <AnalysisSessions {...props} sessionId={sessionId} ready={pane.status === 'synced'} />
}

/** Keep only unfinished sessions mounted. Switching Harness sessions must not discard an editor. */
export function AnalysisSessions({
  sessionId,
  ready,
  ...props
}: AnalysisProps & { sessionId: string | undefined; ready: boolean }) {
  const { t } = props
  const [unfinished, setUnfinished] = useState<Record<string, boolean>>({})
  const callback = useRef(props.onDirtyChange)
  callback.current = props.onDirtyChange
  const dirty = Object.values(unfinished).some(Boolean)
  useEffect(() => {
    callback.current(dirty)
    return () => callback.current(false)
  }, [dirty])
  const sessions = new Set(Object.keys(unfinished).filter(id => unfinished[id]))
  if (sessionId) sessions.add(sessionId)
  return (
    <>
      {!sessionId && (
        <section className="oryh-analysis">
          <PageHeader title={t('pageTitle')} />
          <p className="muted">{t('analysisNoSession')}</p>
        </section>
      )}
      {[...sessions].map(id => (
        <div key={key(props.connection, id)} hidden={id !== sessionId}>
          <AnalysisPage
            {...props}
            sessionId={id}
            active={props.active && id === sessionId}
            ready={id === sessionId ? ready : true}
            onContext={value => {
              if (id === sessionId && props.active) props.onContext(value)
            }}
            onDirtyChange={value =>
              setUnfinished(current => (current[id] === value ? current : { ...current, [id]: value }))
            }
          />
        </div>
      ))}
    </>
  )
}
export function AnalysisPage({
  face,
  t,
  connection,
  sessionId,
  active,
  onContext,
  onDirtyChange,
  api,
  customApi,
  ready = true,
  useSelection,
  openAnalysis,
  setDirty,
}: AnalysisProps & { sessionId: string; ready?: boolean }) {
  const scope = key(connection, sessionId),
    selected = useSelection(scope) ?? NOTHING_OPEN
  const [documents, setDocuments] = useState<AnalysisDocument[]>([]),
    [document, setDocument] = useState<AnalysisDocument>()
  const [draft, setDraft] = useState<AnalysisDefinition>(defaultDefinition),
    [result, setResult] = useState<AnalysisResult>()
  const [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [group, setGroup] = useState<string>()
  const [leaving, setLeaving] = useState<'list' | 'reset'>()
  const sequence = useRef(0),
    live = useRef(true)
  const callbacks = useRef({ onContext, onDirtyChange })
  callbacks.current = { onContext, onDirtyChange }
  const editing = creating || Boolean(selected.id)
  useBeforeUnload(selected.dirty || (editing && busy))
  const request = { sessionId, connectionId: connection.id }
  const allowed = Object.entries(sources).filter(([source]) => canAccessPage(connection.identity, source))
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      sequence.current++
      callbacks.current.onDirtyChange(false)
    }
  }, [])
  useEffect(() => {
    callbacks.current.onDirtyChange(selected.dirty || busy)
  }, [selected.dirty, busy])
  async function run<T>(work: () => Promise<T>, apply: (value: T) => void) {
    const seq = ++sequence.current
    setBusy(true)
    setError('')
    try {
      const value = await work()
      if (live.current && seq === sequence.current) apply(value)
    } catch (e) {
      if (live.current && seq === sequence.current) {
        setResult(undefined)
        setError(e instanceof Error ? e.message : t('analysisLoadFailed'))
      }
    } finally {
      if (live.current && seq === sequence.current) setBusy(false)
    }
  }
  function reload() {
    if (selected.dirty) return
    setGroup(undefined)
    setResult(undefined)
    if (selected.id)
      void run(
        () => api.load({ ...request, id: selected.id }),
        view => {
          setDocument(view.document)
          setDraft(view.document.definition)
          setResult(view.result)
          setCreating(false)
        },
      )
    else
      void run(
        () => api.list(request),
        list => {
          setDocuments(list)
          setDocument(undefined)
          setCreating(false)
        },
      )
  }
  useEffect(() => {
    if (!ready) {
      sequence.current++
      setBusy(false)
      setError('')
      return
    }
    if (active && !selected.dirty) reload()
  }, [active, selected.id, selected.request, ready])
  const content = JSON.stringify({
    id: document?.id,
    version: document?.version,
    definition: editing ? draft : undefined,
    dirty: selected.dirty,
    loading: busy,
    error: error || undefined,
    savedAnalyses: editing
      ? undefined
      : documents.map(d => ({ id: d.id, title: d.definition.title, version: d.version })),
    result: result
      ? { ...result, rows: undefined, groups: result.groups.map(({ rowIds: _ids, ...rest }) => rest) }
      : undefined,
    selectedGroup: result?.groups.find(g => groupId(g) === group)?.key,
    selectedGroupId: group,
    visibleRows:
      result && group
        ? result.rows
            .filter(r => result.groups.find(g => groupId(g) === group)?.rowIds.includes(r.id))
            .map(r => ({ id: r.id, title: r.title, status: r.status }))
        : undefined,
  })
  useEffect(() => {
    callbacks.current.onContext({
      key: editing ? `analytics:${selected.id || 'new'}` : 'analytics:list',
      title: editing ? draft.title : t('pageTitle'),
      detail: selected.dirty ? t('analysisUnsaved') : t('analysisContextSaved'),
      scope: t('analysisContextScope'),
      content,
      ...(selected.dirty ? { unsaved: true } : {}),
    })
  }, [content, editing, selected.id, selected.dirty, draft.title, t])
  function change(patch: Partial<AnalysisDefinition>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    setDirty(scope, creating || JSON.stringify(next) !== JSON.stringify(document?.definition))
    if (['source', 'query', 'filters', 'productIds', 'groupBy', 'measure'].some(k => k in patch)) setResult(undefined)
    else if (result && ('sort' in patch || 'topN' in patch)) {
      try {
        setResult({ ...result, groups: aggregate({ ...draft, ...patch }, result.rows) })
        setError('')
      } catch (e) {
        setResult(undefined)
        setError(e instanceof Error ? e.message : t('analysisSortInvalid'))
      }
    }
    setGroup(undefined)
  }
  function editSections(sections: AnalysisSection[]) {
    change({
      sections,
      summary: sections.find(s => s.id === 'summary')?.body ?? '',
      findings: sections.find(s => s.id === 'findings')?.body ?? '',
      nextSteps: sections.find(s => s.id === 'nextSteps')?.body ?? '',
    })
  }
  function alterSection(action: Parameters<typeof changeSection>[1]) {
    try {
      editSections(changeSection(draft, action).sections)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('analysisSectionFailed'))
    }
  }
  function create(kind: AnalysisDefinition['kind']) {
    const source = (allowed[0]?.[0] ?? 'inventory-items') as AnalysisDefinition['source']
    setDocument(undefined)
    setDraft({
      ...defaultDefinition(),
      sections: defaultDefinition().sections.map((section, index) => ({
        ...section,
        title: t((['analysisSummaryTitle', 'analysisFindingsTitle', 'analysisNextStepsTitle'] as const)[index]!),
      })),
      kind,
      title: kind === 'chart' ? t('analysisNewChartTitle') : t('analysisNewReportTitle'),
      source,
      groupBy: sources[source].dimensions[0]!,
    })
    setResult(undefined)
    setCreating(true)
    setDirty(scope, true)
  }
  function save() {
    void run(
      () =>
        api.save({
          ...request,
          definition: draft,
          ...(document ? { id: document.id, expectedVersion: document.version } : {}),
        }),
      view => {
        setDocument(view.document)
        setDraft(view.document.definition)
        setResult(view.result)
        setCreating(false)
        openAnalysis(scope, view.document.id)
      },
    )
  }
  const labels = Object.fromEntries(
      Object.entries(recordColumns(draft.source)).map(([key, label]) => [key, displayField(face.frame.t, key, label)]),
    ),
    values = result?.groups ?? []
  const max = Math.max(1, ...values.map(g => Math.abs(Number(g.value))))
  const axis = values.some(g => Number(g.value) < 0) ? 200 : 0,
    span = axis ? 198 : 398
  const rows =
    group && result ? result.rows.filter(r => values.find(g => groupId(g) === group)?.rowIds.includes(r.id)) : []
  const measure = (id: string) => (id === 'count' ? t('analysisMeasureCount') : labels[id])
  // What the analysis is narrowed to, as one sentence: the field conditions, with the search before them
  // and the chosen products after, where there are any.
  const conditions = draft.filters.length
    ? draft.filters
        .map(f => t('analysisScopeCondition', { field: labels[f.field] ?? f.field, value: f.value }))
        .join(t('analysisScopeJoin'))
    : t('analysisScopeNoFields')
  const narrowed = { query: draft.query, conditions, count: draft.productIds.length }
  const scopeNote = draft.query
    ? draft.productIds.length
      ? t('analysisScopeSearchProducts', narrowed)
      : t('analysisScopeSearch', narrowed)
    : draft.productIds.length
      ? t('analysisScopeProducts', narrowed)
      : conditions
  return (
    <section className="oryh-analysis" aria-label={t('analysisRegion')}>
      <PageHeader
        title={editing ? draft.title : t('pageTitle')}
        note={selected.dirty ? t('analysisUnsaved') : editing ? t('analysisNoteSaved') : t('analysisNoteIntro')}
        {...(editing
          ? {
              back: (
                <BackToList
                  t={face.frame.t}
                  disabled={busy || !ready}
                  onClick={() => {
                    if (selected.dirty) {
                      setLeaving('list')
                      return
                    }
                    setCreating(false)
                    openAnalysis(scope, '')
                  }}
                />
              ),
            }
          : {})}
        actions={
          <>
            <RefreshButton t={face.frame.t} disabled={busy || !ready || selected.dirty} onClick={reload} />
            {editing ? (
              <>
                <Button disabled={busy || !ready || !selected.dirty} onClick={() => setLeaving('reset')}>
                  {t('analysisDiscard')}
                </Button>
                <Button variant="primary" disabled={busy || !ready || !selected.dirty} onClick={save}>
                  {busy ? t('analysisSaving') : t('analysisSave')}
                </Button>
              </>
            ) : (
              <>
                <Button disabled={busy || !ready || !allowed.length} onClick={() => create('chart')}>
                  {t('analysisNewChart')}
                </Button>
                <Button variant="primary" disabled={busy || !ready || !allowed.length} onClick={() => create('report')}>
                  {t('analysisNewReport')}
                </Button>
              </>
            )}
          </>
        }
      />
      <DraftLeaveDialog
        t={face.frame.t}
        open={Boolean(leaving)}
        onCancel={() => setLeaving(undefined)}
        onDiscard={() => {
          setCreating(false)
          openAnalysis(scope, leaving === 'list' ? '' : (document?.id ?? ''))
          setLeaving(undefined)
        }}
      />
      {!ready ? (
        <p className="muted" role="status">
          {t('analysisBinding')}
        </p>
      ) : null}
      {error ? <ErrorNote face={face} message={error} /> : null}
      {busy ? <ListLoading t={face.frame.t} label={t('analysisLoading')} /> : null}
      {!editing ? (
        <div className="analysis-library">
          {customApi && (
            <CustomPageList face={face} t={t} api={customApi} request={request} ready={ready} active={active} />
          )}
          {!busy && !documents.length && !customApi ? (
            <div className="analysis-empty">
              <IconChartBar size={36} />
              <h2>{t('analysisEmptyTitle')}</h2>
              <p>{t('analysisEmptyHint')}</p>
            </div>
          ) : (
            documents.map(d => (
              <button type="button" className="analysis-document" key={d.id} onClick={() => openAnalysis(scope, d.id)}>
                <span>
                  {t(d.definition.kind === 'chart' ? 'analysisDocumentChart' : 'analysisDocumentReport', {
                    source: displaySource(face.frame.t, d.definition.source),
                  })}
                </span>
                <strong>{d.definition.title}</strong>
                <small>{t('analysisUpdatedAt', { time: formatDateTime(d.updatedAt) })}</small>
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <details className="analysis-settings" open={creating || !result}>
            <summary>
              {t('analysisSettingsSummary', {
                source: displaySource(face.frame.t, draft.source),
                group: labels[draft.groupBy] ?? '',
                measure: measure(draft.measure) ?? '',
              })}
            </summary>
            <fieldset className="analysis-controls" disabled={busy || !ready}>
              <legend>{t('analysisSettings')}</legend>
              <label className="analysis-title">
                {t('analysisFieldTitle')}
                <input value={draft.title} maxLength={80} onChange={e => change({ title: e.target.value })} />
              </label>
              <label>
                {t('analysisFieldSource')}
                <select
                  value={draft.source}
                  onChange={e => {
                    const source = e.target.value as AnalysisDefinition['source']
                    change({
                      source,
                      groupBy: sources[source].dimensions[0]!,
                      measure: 'count',
                      query: '',
                      filters: [],
                      productIds: [],
                    })
                  }}
                >
                  {allowed.map(([id, s]) => (
                    <option key={id} value={id}>
                      {displaySource(face.frame.t, id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('analysisFieldGroup')}
                <select value={draft.groupBy} onChange={e => change({ groupBy: e.target.value })}>
                  {sources[draft.source].dimensions.map(id => (
                    <option key={id} value={id}>
                      {labels[id]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('analysisFieldMeasure')}
                <select value={draft.measure} onChange={e => change({ measure: e.target.value, topN: 0 })}>
                  {sources[draft.source].measures.map(id => (
                    <option key={id} value={id}>
                      {measure(id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('analysisFieldDisplay')}
                <select value={draft.display} onChange={e => change({ display: e.target.value as 'bar' | 'table' })}>
                  <option value="bar">{t('analysisDisplayBar')}</option>
                  <option value="table">{t('analysisDisplayTable')}</option>
                </select>
              </label>
              <label>
                {t('analysisFieldSort')}
                <select
                  value={draft.sort}
                  onChange={e =>
                    change({
                      sort: e.target.value as AnalysisDefinition['sort'],
                      ...(e.target.value !== 'value-desc' ? { topN: 0 } : {}),
                    })
                  }
                >
                  <option value="label">{t('analysisSortLabel')}</option>
                  <option value="value-desc">{t('analysisSortDesc')}</option>
                  <option value="value-asc">{t('analysisSortAsc')}</option>
                </select>
              </label>
              <label>
                {t('analysisFieldTopN')}
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  disabled={draft.measure !== 'count'}
                  value={draft.topN}
                  onChange={e =>
                    change({
                      topN: Number(e.target.value),
                      ...(Number(e.target.value) > 0 ? { sort: 'value-desc' } : {}),
                    })
                  }
                />
                <small>{t('analysisTopNHint')}</small>
              </label>
              <label>
                {t('analysisFieldKind')}
                <select value={draft.kind} onChange={e => change({ kind: e.target.value as 'chart' | 'report' })}>
                  <option value="chart">{t('analysisKindChart')}</option>
                  <option value="report">{t('analysisKindReport')}</option>
                </select>
              </label>
              <div className="analysis-filters">
                <strong>{t('analysisFilters')}</strong>
                <span>{scopeNote}</span>
                <Button
                  variant="ghost"
                  disabled={!draft.query && !draft.filters.length && !draft.productIds.length}
                  onClick={() => change({ query: '', filters: [], productIds: [] })}
                >
                  {face.frame.t('listClear')}
                </Button>
                <Button onClick={() => void run(() => api.preview({ ...request, definition: draft }), setResult)}>
                  {t('analysisPreview')}
                </Button>
              </div>
            </fieldset>
          </details>
          {result ? (
            <article className="analysis-output">
              <header>
                <div>
                  <span className="analysis-eyebrow">
                    {displaySource(face.frame.t, result.source, result.sourceTitle)} /{' '}
                    {displayField(face.frame.t, result.groupBy ?? '', result.groupLabel)}
                  </span>
                  <h2>
                    {result.measure === 'count'
                      ? t('analysisMeasureCount')
                      : displayField(face.frame.t, result.measure ?? '', result.measureLabel)}
                  </h2>
                </div>
                <div className="analysis-total">
                  <strong>{result.total}</strong>
                  <span>{t('analysisTotalNote', { groups: values.length })}</span>
                </div>
              </header>
              <p className="analysis-scope">
                {draft.topN ? t('analysisResultTop', { top: draft.topN, total: result.total }) : t('analysisResultAll')}
                {draft.sort === 'value-desc'
                  ? t('analysisResultSortDesc')
                  : draft.sort === 'value-asc'
                    ? t('analysisResultSortAsc')
                    : t('analysisResultSortLabel')}
              </p>
              {!values.length ? (
                <p className="analysis-empty">{t('analysisResultEmpty')}</p>
              ) : draft.display === 'bar' ? (
                <div className="analysis-bars" role="group" aria-label={t('analysisChartRegion')}>
                  {values.map(g => (
                    <button
                      type="button"
                      key={groupId(g)}
                      className="analysis-bar"
                      aria-label={t('analysisBarLabel', { key: g.key, value: g.value })}
                      aria-pressed={group === groupId(g)}
                      onClick={() => setGroup(group === groupId(g) ? undefined : groupId(g))}
                    >
                      <span title={g.key}>{g.key}</span>
                      <svg viewBox="0 0 400 26" preserveAspectRatio="none" aria-hidden="true">
                        <line x1={axis} y1="0" x2={axis} y2="26" />
                        <rect
                          x={Number(g.value) < 0 ? axis - (Math.abs(Number(g.value)) / max) * span : axis}
                          y="3"
                          width={Math.max(0, (Math.abs(Number(g.value)) / max) * span)}
                          height="20"
                          rx="3"
                        />
                      </svg>
                      <strong>{g.value}</strong>
                    </button>
                  ))}
                </div>
              ) : null}
              <details open={draft.display === 'table'}>
                <summary>{t('analysisStats')}</summary>
                <div className="analysis-table">
                  <table>
                    <thead>
                      <tr>
                        <th>{displayField(face.frame.t, result.groupBy ?? '', result.groupLabel)}</th>
                        <th>
                          {result.measure === 'count'
                            ? t('analysisMeasureCount')
                            : displayField(face.frame.t, result.measure ?? '', result.measureLabel)}
                        </th>
                        <th>{t('analysisSourceCount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {values.map(g => (
                        <tr key={groupId(g)}>
                          <td>
                            <button type="button" onClick={() => setGroup(groupId(g))}>
                              {g.key}
                            </button>
                          </td>
                          <td>{g.value}</td>
                          <td>{g.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              {group ? (
                <section className="analysis-drill" aria-label={t('analysisDrillRegion')}>
                  <h3>
                    {t('analysisDrillTitle', {
                      key: values.find(g => groupId(g) === group)?.key ?? '',
                      count: rows.length,
                    })}
                  </h3>
                  <Button variant="ghost" onClick={() => setGroup(undefined)}>
                    {t('analysisDrillClose')}
                  </Button>
                  <div className="analysis-table">
                    <table>
                      <thead>
                        <tr>
                          <th>{t('analysisColumnRecord')}</th>
                          <th>{t('analysisColumnStatus')}</th>
                          <th>{t('analysisColumnId')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.id}>
                            <td>{r.title}</td>
                            <td>{r.status || '—'}</td>
                            <td>{r.id}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}
              <footer className="analysis-provenance">
                <span>{t('analysisFetchedAt', { time: formatDateTime(result.fetchedAt) })}</span>
                <p>{t('analysisDataNotice')}</p>
              </footer>
            </article>
          ) : !busy ? (
            <p className="muted">{t('analysisNoResult')}</p>
          ) : null}
          {draft.kind === 'report' ? (
            <fieldset className="analysis-report" disabled={busy || !ready}>
              <legend>{t('analysisReportBody')}</legend>
              <p className="muted">{t('analysisReportHint')}</p>
              {draft.sections.map((section, index) => (
                <section
                  className="analysis-section"
                  key={section.id}
                  aria-label={t('analysisSectionRegion', { number: index + 1, title: section.title })}
                >
                  <div className="analysis-section-header">
                    <span className="analysis-section-number">{String(index + 1).padStart(2, '0')}</span>
                    <input
                      aria-label={t('analysisSectionTitleLabel', { number: index + 1 })}
                      value={section.title}
                      maxLength={80}
                      onChange={e =>
                        editSections(
                          draft.sections.map(s => (s.id === section.id ? { ...s, title: e.target.value } : s)),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      aria-label={t('analysisSectionUpLabel', { number: index + 1 })}
                      disabled={index === 0}
                      onClick={() =>
                        alterSection({
                          action: 'move',
                          sectionId: section.id,
                          afterId: index === 1 ? '' : draft.sections[index - 2]!.id,
                        })
                      }
                    >
                      {t('analysisSectionUp')}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={t('analysisSectionDownLabel', { number: index + 1 })}
                      disabled={index === draft.sections.length - 1}
                      onClick={() =>
                        alterSection({ action: 'move', sectionId: section.id, afterId: draft.sections[index + 1]!.id })
                      }
                    >
                      {t('analysisSectionDown')}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={t('analysisSectionRemoveLabel', { number: index + 1 })}
                      onClick={() => alterSection({ action: 'remove', sectionId: section.id })}
                    >
                      {t('analysisSectionRemove')}
                    </Button>
                  </div>
                  <textarea
                    aria-label={section.title || t('analysisSectionBodyLabel', { number: index + 1 })}
                    rows={section.id === 'findings' ? 6 : 3}
                    maxLength={10000}
                    value={section.body}
                    placeholder={t('analysisSectionPlaceholder')}
                    onChange={e =>
                      editSections(draft.sections.map(s => (s.id === section.id ? { ...s, body: e.target.value } : s)))
                    }
                  />
                </section>
              ))}
              <Button
                disabled={draft.sections.length >= 20}
                onClick={() =>
                  alterSection({ action: 'add', sectionId: crypto.randomUUID(), title: t('analysisSectionNew') })
                }
              >
                {t('analysisSectionAdd')}
              </Button>
            </fieldset>
          ) : null}
        </>
      )}
    </section>
  )
}
