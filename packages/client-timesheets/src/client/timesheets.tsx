import type { ConnectionSummary } from '@oryh/ai-client-core/types'
import type { PageId } from '@oryh/ai-client-pages'
import { hasPermission } from '@oryh/ai-client-pages'
import type {
  TimesheetAction,
  TimesheetDetail,
  TimesheetFields,
  TimesheetHeader,
  TimesheetIntent,
  TimesheetLine,
  TimesheetOptions,
  TimesheetTodo,
} from '@oryh/ai-client-timesheets'
import { TIMESHEET_OBJECT_TYPE } from '@oryh/ai-client-timesheets/contracts'
import {
  BackToList,
  BusinessSessionContext,
  Button,
  ClearConditionsButton,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  EmptyState,
  ErrorNote,
  Field,
  formatDate,
  formatDateTime,
  formatDisplayValue,
  Input,
  ListFooter,
  ListLoading,
  NewButton,
  type PageContext,
  PageHeader,
  PreferenceDetails,
  pagePreference,
  RefreshButton,
  RowOpenCell,
  RowOpenHeader,
  Select,
  StaleNote,
  StatusPill,
  statusLabel,
  statusTone,
  textPreference,
  useCommand,
  useOryhRemote,
  usePane,
  useServerRefresh,
  useText,
  useViewPreference,
} from '@oryh/dsh-client-frame/client'
import { IconSearch } from '@tabler/icons-react'
import { useContext, useEffect, useRef, useState } from 'react'
import { useTimesheetsApi } from './api.js'
import { TimesheetChat } from './timesheet-chat.js'
import { TimesheetEditor } from './timesheet-editor.js'

const today = () => formatDate(new Date())
const blankLine = (): TimesheetLine => ({
  work_date: today(),
  hours: 0,
  work_type: '',
  project_id: '',
  task: '',
  notes: '',
})
const blank = (): TimesheetFields => ({
  period_start: today(),
  period_end: today(),
  source_report_text: '',
  entries: [blankLine()],
})
const sum = (entries: TimesheetLine[]) => Number(entries.reduce((n, l) => n + (Number(l.hours) || 0), 0).toFixed(6))
export function TimesheetPanel({
  connection,
  manager,
  active,
  onDirtyChange,
  onContext,
}: {
  connection: ConnectionSummary
  manager: boolean
  active: boolean
  onDirtyChange: (v: boolean) => void
  onContext: (v: PageContext) => void
}) {
  const api = useTimesheetsApi(),
    frame = useOryhRemote(),
    t = useText(),
    alive = useRef(true)
  const [headers, setHeaders] = useState<TimesheetHeader[]>([]),
    [todos, setTodos] = useState<TimesheetTodo[]>([]),
    [history, setHistory] = useState<TimesheetIntent[]>([])
  const [options, setOptions] = useState<TimesheetOptions>({
      workTypes: [],
      projects: [],
      requirements: [],
      editableStates: [],
      submitStates: [],
    }),
    [detail, setDetail] = useState<TimesheetDetail>(),
    [todoId, setTodoId] = useState<string>()
  const [editor, setEditor] = useState(false),
    [fields, setFields] = useState(blank),
    [editing, setEditing] = useState<{ entryId?: string; line: TimesheetLine }>(),
    [dirty, setDirty] = useState(false)
  const [loaded, setLoaded] = useState(false),
    [leaveOpen, setLeaveOpen] = useState(false),
    [stale, setStale] = useState(false)
  function returnToList() {
    setDetail(undefined)
    setEditor(false)
    setEditing(undefined)
    setReview(undefined)
    setDirty(false)
    setError('')
    setLeaveOpen(false)
    setStale(false)
  }
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [review, setReview] = useState<TimesheetIntent>(),
    [query, setQuery] = useViewPreference(`timesheets:${manager}:query`, '', textPreference)
  const [status, setStatus] = useViewPreference(`timesheets:${manager}:status`, '', textPreference),
    [page, setPage] = useViewPreference(`timesheets:${manager}:page`, 1, pagePreference)
  const filteredHeaders = headers.filter(
    r =>
      `${r.period_start} ${r.period_end} ${r.status} ${statusLabel(r.status)} ${r.source_report_text}`.includes(
        query,
      ) &&
      (!status || r.status === status),
  )
  const filteredTodos = todos.filter(r => `${r.title} ${r.description}`.includes(query))
  const count = manager ? filteredTodos.length : filteredHeaders.length,
    pages = Math.max(1, Math.ceil(count / 12)),
    currentPage = Math.min(page, pages)
  const visibleHeaders = filteredHeaders.slice((currentPage - 1) * 12, currentPage * 12),
    visibleTodos = filteredTodos.slice((currentPage - 1) * 12, currentPage * 12)
  const [decision, setDecision] = useState<'approved' | 'rejected' | 'returned'>('approved'),
    [comment, setComment] = useState('')
  const sessionId = useContext(BusinessSessionContext),
    reviewState = usePane().state.review
  const [normError, setNormError] = useState(''),
    [normSince, setNormSince] = useState(0),
    [, setNormTick] = useState(0)
  /**
   * Where the pre-submit norm review stands, for the submit dialog only.
   *
   * The norms live on the server and in ORYH's Skills, so the verdict can only come from the agent;
   * this just reports it.
   * A verdict about a different timesheet is ignored rather than shown against this one.
   */
  const norm = (() => {
    if (review?.action.kind !== 'submit') return undefined
    if (normError) return { phase: 'unavailable' as const, message: normError }
    const s =
      reviewState &&
      reviewState.objectType === TIMESHEET_OBJECT_TYPE &&
      reviewState.documentId === review.action.headerId
        ? reviewState
        : undefined
    // Before the first frame arrives the review is already queued Host-side, so treat it as such.
    if (!s) return { phase: 'queued' as const, message: '' }
    // `unavailable` now also arrives from the Host, which is what settles a review whose turn died
    // (a model quota error, say) or never reported. Without it the dialog waited forever, and since
    // submitting is gated on the verdict, waiting forever is a dead end rather than a slow path.
    return { phase: s.status, message: s.message ?? '' }
  })()
  const normRunning = norm?.phase === 'queued' || norm?.phase === 'reviewing'
  const normElapsed = normRunning && normSince ? Math.floor((Date.now() - normSince) / 1000) : 0
  useEffect(() => {
    if (!normRunning) return
    const t = setInterval(() => setNormTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [normRunning])
  function normReset() {
    setNormError('')
    setNormSince(0)
    if (sessionId) void frame.reviewClear(sessionId).catch(() => {})
  }
  useEffect(() => {
    alive.current = true
    void run(refresh)
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    onDirtyChange(dirty || busy)
    return () => onDirtyChange(false)
  }, [dirty, busy, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const hostPage: PageId = manager ? 'timesheet-approvals' : 'timesheets'
  // The agent opens a timesheet, or the blank form. What it may replace is only a draft it saw itself.
  useCommand(
    'navigation',
    hostPage,
    navigation => {
      if (navigation.target !== 'timesheet' || !active || !loaded || busy) return false
      if (navigation.headerId) {
        // The agent may replace a draft it already wrote to ORYH, but only while the form is exactly as it saw it.
        const replaceable = editor && !editing && !review && navigation.discardForm === JSON.stringify(fields)
        if (dirty && !replaceable) {
          setError('当前有未保存修改，请保存或放弃后重新要求打开工时。')
          return true
        }
        void run(() => open(navigation.headerId!, navigation.todoId))
        return true
      }
      if (manager || !hasPermission(connection.identity, 'timesheet.submit_own')) return true
      if ((editor && !detail) || dirty) return true
      setFields(blank())
      setEditor(true)
      setDetail(undefined)
      setEditing(undefined)
      setDirty(true)
      return true
    },
    [active, loaded, busy, editor, editing, review, fields, dirty, manager, detail],
  )
  const localEdits = JSON.stringify({
    editing,
    decision,
    comment,
    query,
    status,
    page: currentPage,
    pages,
    busy,
    detail,
    visibleRows: editor || detail ? [] : manager ? visibleTodos : visibleHeaders,
  })
  const contextCallback = useRef(onContext)
  contextCallback.current = onContext
  // What the pane shows, for Chat: the document open, the unsaved form, and the page's transient state.
  useEffect(() => {
    if (!active) return
    contextCallback.current({
      key: `${hostPage}:${editor ? (detail?.header.id ?? 'new') : (detail?.header.id ?? 'list')}`,
      title: editor
        ? detail
          ? '编辑工时'
          : t('tsNew')
        : detail
          ? `${detail.header.period_start} — ${detail.header.period_end}`
          : t(hostPage === 'timesheets' ? 'tsMine' : 'tsApprovals'),
      detail: dirty ? '有未保存修改' : '',
      scope: manager ? '本人审批队列' : '本人工时',
      timesheet: {
        manager,
        ...(detail ? { headerId: detail.header.id } : {}),
        ...(todoId ? { todoId } : {}),
        ...(editor ? { fields } : {}),
        localEdits,
      },
    })
  }, [active, hostPage, editor, detail, dirty, manager, todoId, fields, localEdits, t])
  async function run(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t('tsFailed'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  async function refresh() {
    const [hs, ts, opts, log] = await Promise.all([
      manager ? Promise.resolve([]) : api.timesheetList(connection.id),
      manager ? api.timesheetQueue(connection.id) : Promise.resolve([]),
      api.timesheetOptions(connection.id),
      api.timesheetHistory(connection.id),
    ])
    if (alive.current) {
      setHeaders(hs)
      setTodos(ts)
      setOptions(opts)
      setHistory(log)
      setLoaded(true)
    }
    return { hs, ts }
  }
  /**
   * Show what the server holds now, after the agent may have written in Chat (ADR-0010).
   *
   * The list re-reads, and an open timesheet is read again and stays open: a draft submitted in Chat
   * turns into its read-only 已提交 detail, and one approved in Chat leaves the queue with a word why.
   * Unsaved edits and an open confirmation are never replaced; the page says the server may have
   * moved on and lets the person choose.
   */
  async function followServer() {
    const { hs, ts } = await refresh()
    if (!alive.current || !detail) return
    if (dirty || review) {
      setStale(true)
      return
    }
    const id = detail.header.id
    if (manager ? !ts.some(t => t.id === todoId) : !hs.some(h => h.id === id)) {
      returnToList()
      setMessage(manager ? '这条审批已处理，已返回审批列表。' : '这张工时单已不在你的工时列表中，已返回列表。')
      return
    }
    await open(id, todoId)
  }
  const followPending = useRef(false)
  useServerRefresh(active, () => {
    if (busy) {
      followPending.current = true
      return
    }
    void run(followServer)
  })
  useEffect(() => {
    if (!busy && followPending.current) {
      followPending.current = false
      void run(followServer)
    }
  }, [busy])
  async function open(id: string, tid?: string) {
    const d = await api.timesheetDetail(connection.id, id, tid)
    if (alive.current) {
      setStale(false)
      setDetail(d)
      setTodoId(tid)
      setComment('')
      setEditor(Boolean(d.canEdit && !manager && hasPermission(connection.identity, 'timesheet.submit_own')))
      setFields({
        period_start: d.header.period_start,
        period_end: d.header.period_end,
        source_report_text: d.header.source_report_text,
        entries: d.entries.map(l => ({ ...l })),
      })
      setEditing(undefined)
      setReview(undefined)
      setMessage('')
      setDirty(false)
    }
  }
  async function prepare(action: TimesheetAction) {
    const r = await api.timesheetPrepare(connection.id, action)
    if (alive.current) {
      setReview(r)
      setHistory(h => [r, ...h.filter(x => x.id !== r.id)])
    }
  }
  function change(f: TimesheetFields) {
    setFields(f)
    setDirty(true)
    setReview(undefined)
  }
  function renderLines(entries: TimesheetLine[]) {
    const daily = new Map<string, number>()
    entries.forEach(e => daily.set(e.work_date, (daily.get(e.work_date) ?? 0) + e.hours))
    return (
      <>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {['tsDate', 'tsHours', 'tsType', 'tsProject', 'tsTask', 'tsNotes'].map(k => (
                  <th key={k}>{t(k as 'tsDate')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <td>{e.work_date}</td>
                  <td>{e.hours}</td>
                  <td>{options.workTypes.find(o => o.name === e.work_type)?.title || e.work_type || '—'}</td>
                  <td>
                    {options.projects.find(o => o.id === e.project_id)?.name ||
                      ('projectName' in e ? String(e.projectName) : '') ||
                      e.project_id ||
                      '—'}
                  </td>
                  <td>
                    {e.task || '—'}
                    {'client' in e && Boolean(e.client) && <p>{String(e.client)}</p>}
                  </td>
                  <td>{e.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>
            {t('tsTotal')}：{sum(entries)}
          </strong>
        </p>
        <p>
          {t('tsDaily')}：
          {[...daily]
            .sort()
            .map(([d, n]) => `${d} · ${Number(n.toFixed(6))}h`)
            .join(' / ')}
        </p>
      </>
    )
  }
  const panel = useRef<HTMLElement>(null),
    listScroll = useRef(0),
    previousDetail = useRef(false)
  useEffect(() => {
    const seat = panel.current?.closest<HTMLElement>('.oryh-business-seat')
    const showing = editor || Boolean(detail)
    if (seat && showing !== previousDetail.current) {
      if (showing) {
        listScroll.current = seat.scrollTop
        seat.scrollTop = 0
        panel.current?.querySelector<HTMLButtonElement>('.business-page-header button')?.focus({ preventScroll: true })
      } else seat.scrollTop = listScroll.current
    }
    previousDetail.current = showing
  }, [editor, detail])
  const actionTitle = (a: TimesheetAction) =>
    t(
      a.kind === 'update'
        ? 'tsEdit'
        : a.kind === 'create'
          ? 'tsCreate'
          : a.kind === 'submit'
            ? 'tsSending'
            : a.kind === 'approve'
              ? 'tsApprovalAction'
              : a.kind === 'add-line'
                ? 'tsAdd'
                : a.kind === 'edit-line'
                  ? 'tsEdit'
                  : 'tsRemove',
    )
  return (
    <section ref={panel} className="oryh-timesheets" aria-busy={busy}>
      <PageHeader
        back={
          (editor || detail) && (
            <BackToList disabled={busy} onClick={() => (dirty ? setLeaveOpen(true) : returnToList())} />
          )
        }
        title={
          editor
            ? detail
              ? '编辑工时'
              : t('tsNew')
            : detail
              ? `${detail.header.period_start} — ${detail.header.period_end}`
              : t(manager ? 'tsApprovals' : 'tsMine')
        }
        status={
          detail ? (
            <StatusPill tone={statusTone(detail.header.status)}>{statusLabel(detail.header.status)}</StatusPill>
          ) : (
            editor && <StatusPill>未保存</StatusPill>
          )
        }
        note={dirty && '请先保存或放弃当前修改'}
        actions={
          !editor &&
          !detail && (
            <>
              <RefreshButton disabled={busy} onClick={() => void run(refresh)} />
              {!manager && hasPermission(connection.identity, 'timesheet.submit_own') && (
                <NewButton
                  disabled={busy || dirty}
                  onClick={() => {
                    setFields(blank())
                    setEditor(true)
                    setDetail(undefined)
                    setEditing(undefined)
                    setDirty(true)
                  }}
                >
                  {t('tsNew')}
                </NewButton>
              )}
            </>
          )
        }
      />
      {active && (
        <TimesheetChat
          page={hostPage}
          busy={busy}
          dirty={dirty}
          onApply={action => {
            if (action.kind === 'update' && action.fields && detail?.canEdit && action.headerId === detail.header.id) {
              change(action.fields)
            } else if (
              action.kind === 'create' &&
              action.fields &&
              hasPermission(connection.identity, 'timesheet.submit_own')
            ) {
              setFields(action.fields)
              setEditor(true)
              setDetail(undefined)
              setEditing(undefined)
              setDirty(true)
              setReview(undefined)
            } else if (
              editor &&
              detail &&
              action.headerId === detail.header.id &&
              ['add-line', 'edit-line', 'delete-line'].includes(action.kind)
            ) {
              if (action.kind === 'add-line' && action.line)
                change({ ...fields, entries: [...fields.entries, action.line] })
              else if (action.kind === 'edit-line' && action.line)
                change({
                  ...fields,
                  entries: fields.entries.map(l => (l.id === action.entryId ? { ...action.line!, id: l.id! } : l)),
                })
              else if (action.kind === 'delete-line')
                change({ ...fields, entries: fields.entries.filter(l => l.id !== action.entryId) })
            } else if (['update', 'add-line', 'edit-line', 'delete-line'].includes(action.kind))
              setError('请先打开可编辑的工时单，所有明细修改将在整单中保存。')
          }}
        />
      )}
      {!editor && !editing && !review && (
        <>
          {busy && <ListLoading />}
          {error && <ErrorNote message={error} />}
        </>
      )}
      {stale && detail && (
        <StaleNote
          disabled={busy}
          onRefresh={() => {
            const id = detail.header.id
            setDirty(false)
            setReview(undefined)
            normReset()
            void run(() => open(id, todoId))
          }}
        />
      )}
      {message && <p role="status">{message}</p>}

      {!editor && !detail && (
        <section className="surface table-surface" aria-label={t(manager ? 'tsApprovals' : 'tsMine')}>
          <div className="query-toolbar">
            <Field label="关键词">
              <Input
                contentBefore={<IconSearch size={16} />}
                placeholder={manager ? '审批事项或工作说明' : '日期、工作说明或状态'}
                value={query}
                onChange={(_, d) => {
                  setQuery(d.value)
                  setPage(1)
                }}
              />
            </Field>
            {!manager && (
              <Field label="状态">
                <Select
                  value={status}
                  onChange={e => {
                    setStatus(e.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">全部状态</option>
                  {[...new Set(headers.map(h => h.status))].map(s => (
                    <option key={s} value={s}>
                      {statusLabel(s)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {(query || status) && (
              <ClearConditionsButton
                onClick={() => {
                  setQuery('')
                  setStatus('')
                  setPage(1)
                }}
              />
            )}
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{manager ? '审批事项' : '申报期间'}</th>
                  <th scope="col">工作说明</th>
                  <th scope="col">状态</th>
                  <RowOpenHeader />
                </tr>
              </thead>
              <tbody>
                {manager
                  ? visibleTodos.map(r => (
                      <tr key={r.id}>
                        <td>
                          <button
                            className="record-link"
                            disabled={busy}
                            onClick={() => void run(() => open(r.entity_id, r.id))}
                          >
                            {r.title}
                          </button>
                        </td>
                        <td>{r.description || '—'}</td>
                        <td>
                          <StatusPill tone="pending">待审批</StatusPill>
                        </td>
                        <RowOpenCell
                          title={r.title}
                          disabled={busy}
                          onOpen={() => void run(() => open(r.entity_id, r.id))}
                        />
                      </tr>
                    ))
                  : visibleHeaders.map(r => (
                      <tr key={r.id}>
                        <td>
                          <button
                            className="record-link numeric"
                            disabled={busy}
                            onClick={() => void run(() => open(r.id))}
                          >
                            {r.period_start} — {r.period_end}
                          </button>
                        </td>
                        <td>{r.source_report_text || '—'}</td>
                        <td>
                          <StatusPill tone={statusTone(r.status)}>{statusLabel(r.status)}</StatusPill>
                        </td>
                        <RowOpenCell
                          title={`${r.period_start} — ${r.period_end}`}
                          disabled={busy}
                          onOpen={() => void run(() => open(r.id))}
                        />
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {!count && !busy && (
            <EmptyState
              filtered={Boolean(query || status)}
              {...(query || status
                ? {}
                : { hint: manager ? '新的工时审批将在这里显示。' : '新建工时单，或通过 Chat 描述你的工作。' })}
            />
          )}
          <ListFooter count={count} page={currentPage} pages={pages} disabled={busy} onPage={setPage} />
        </section>
      )}
      {editor && (
        <TimesheetEditor
          key={detail?.header.id ?? 'new'}
          fields={fields}
          options={options}
          busy={busy}
          dirty={dirty}
          existing={Boolean(detail)}
          error={review ? '' : error}
          onChange={change}
          onSave={() =>
            void run(() =>
              prepare(
                detail
                  ? {
                      kind: 'update',
                      headerId: detail.header.id,
                      fields,
                      ...(detail.revision ? { expectedRevision: detail.revision } : {}),
                    }
                  : { kind: 'create', fields },
              ),
            )
          }
          onDiscard={() => {
            if (detail)
              setFields({
                period_start: detail.header.period_start,
                period_end: detail.header.period_end,
                source_report_text: detail.header.source_report_text,
                entries: detail.entries.map(l => ({ ...l })),
              })
            else setEditor(false)
            setDirty(false)
            setReview(undefined)
            setError('')
          }}
        />
      )}
      {editor && detail && (
        <div className="toolbar timesheet-submit">
          <span className="muted">保存修改后，可提交审批。</span>
          <Button
            disabled={busy || dirty || !options.submitStates.includes(detail.header.status)}
            onClick={() =>
              void run(async () => {
                await prepare({ kind: 'submit', headerId: detail.header.id })
                setNormError('')
                setNormSince(Date.now())
                if (!sessionId) {
                  setNormError('当前没有会话，无法进行规范核对。')
                  return
                }
                try {
                  await api.timesheetReviewStart(sessionId, detail.header.id)
                } catch (e) {
                  if (alive.current) setNormError(e instanceof Error ? e.message : '规范核对无法开始。')
                }
              })
            }
          >
            {t('tsSubmit')}
          </Button>
        </div>
      )}
      {detail && !editor && (
        <div className="surface">
          <h2>
            {detail.canEdit && hasPermission(connection.identity, 'timesheet.submit_own') && !manager
              ? '编辑工时'
              : '工时详情 · 只读'}
          </h2>
          {!(detail.canEdit && hasPermission(connection.identity, 'timesheet.submit_own')) && (
            <p>当前身份或单据状态不允许修改工时内容。</p>
          )}
          <p>
            {t('tsEmployee')}：{detail.header.employee_id}
          </p>
          <p>{detail.header.source_report_text}</p>
          {detail.canEdit && hasPermission(connection.identity, 'timesheet.submit_own') && !manager ? (
            <p>
              {t('tsTotal')}：{sum(detail.entries)}
            </p>
          ) : (
            renderLines(detail.entries)
          )}
          <PreferenceDetails preferenceKey={`timesheets:${manager}:trailOpen`}>
            <summary>{t('tsTrail')}</summary>
            {detail.approval_records.map(a => (
              <p key={a.id}>
                {t('tsRound')} {a.round_no}/{a.sequence_no} · {statusLabel(a.action)} · {a.approver_id} ·{' '}
                {formatDisplayValue(a.acted_at)}
                <br />
                {a.comment}
              </p>
            ))}
          </PreferenceDetails>
          {manager && hasPermission(connection.identity, 'approval.record') && (
            <form
              onSubmit={e => {
                e.preventDefault()
                void run(() =>
                  prepare({ kind: 'approve', headerId: detail.header.id, todoId: todoId!, decision, comment }),
                )
              }}
            >
              <fieldset
                disabled={
                  busy || !hasPermission(connection.identity, manager ? 'approval.record' : 'timesheet.submit_own')
                }
              >
                <legend>{t('tsDecision')}</legend>
                <label>
                  {t('tsDecision')}
                  <select
                    value={decision}
                    onChange={e => {
                      setDecision(e.target.value as typeof decision)
                      setDirty(true)
                      setReview(undefined)
                    }}
                  >
                    <option value="approved">{t('tsApprove')}</option>
                    <option value="rejected">{t('tsReject')}</option>
                    <option value="returned">{t('tsReturn')}</option>
                  </select>
                </label>
                <label>
                  {t('tsComment')}
                  <textarea
                    required
                    maxLength={2000}
                    value={comment}
                    onChange={e => {
                      setComment(e.target.value)
                      setDirty(true)
                      setReview(undefined)
                    }}
                  />
                </label>
                <p>{t('tsApprovalBoundary')}</p>
                <Button type="submit" appearance="primary">
                  {t('tsReviewDecision')}
                </Button>
              </fieldset>
            </form>
          )}
        </div>
      )}
      <PreferenceDetails preferenceKey={`timesheets:${manager}:rulesOpen`} className="surface">
        <summary>{t('tsRequirements')}</summary>
        {options.requirements.length ? (
          options.requirements.map((r, i) => <pre key={i}>{r}</pre>)
        ) : (
          <p>{t('tsRuleEmpty')}</p>
        )}
      </PreferenceDetails>
      <PreferenceDetails preferenceKey={`timesheets:${manager}:historyOpen`} className="surface">
        <summary>{t('tsHistory')}</summary>
        {history
          .filter(r => (manager ? r.action.kind === 'approve' : r.action.kind !== 'approve'))
          .map(r => (
            <div key={r.id}>
              <p>
                {actionTitle(r.action)} · {formatDateTime(r.updatedAt)} ·{' '}
                {t(
                  r.state === 'review'
                    ? 'tsReviewState'
                    : r.state === 'done'
                      ? 'tsDoneState'
                      : r.state === 'failed'
                        ? 'tsFailed'
                        : 'tsUnknownState',
                )}
                <br />
                {r.message}
              </p>
              {r.state === 'review' && (
                <Button disabled={busy || dirty} onClick={() => void run(() => prepare(r.action))}>
                  {t('tsResume')}
                </Button>
              )}
              {['unknown', 'executing'].includes(r.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const n = await api.timesheetReconcile(connection.id, r.id, r.revision)
                      if (alive.current) {
                        setMessage(n.message)
                        setHistory(h => h.map(x => (x.id === n.id ? n : x)))
                      }
                    })
                  }
                >
                  {t('tsReconcile')}
                </Button>
              )}
            </div>
          ))}
      </PreferenceDetails>
      <Dialog open={leaveOpen} onOpenChange={(_, d) => setLeaveOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>放弃未保存的修改？</DialogTitle>
            <DialogContent>当前表单的修改还没有保存，包括新增、修改和删除的明细。</DialogContent>
            <DialogActions>
              <Button onClick={() => setLeaveOpen(false)}>继续编辑</Button>
              <Button appearance="primary" onClick={returnToList}>
                放弃并返回
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(_, d) => {
          if (!d.open && !busy) {
            setReview(undefined)
            normReset()
          }
        }}
      >
        <DialogSurface className="oryh-timesheet-review">
          <DialogBody>
            <DialogTitle>
              {t('tsReviewTitle')} · {review && actionTitle(review.action)}
            </DialogTitle>
            <DialogContent>
              <p>
                {connection.identity.tenant.name ?? connection.identity.tenant.slug} · {connection.identity.user.email}
              </p>
              {review?.detail && !review.action.fields && (
                <>
                  <p>
                    {t('tsEmployee')}：{review.detail.header.employee_id} · {review.detail.header.period_start} —{' '}
                    {review.detail.header.period_end}
                  </p>
                  <p>{review.detail.header.source_report_text}</p>
                  {renderLines(review.detail.entries)}
                </>
              )}
              {review?.action.fields && (
                <>
                  <p>
                    {review.action.fields.period_start} — {review.action.fields.period_end}
                  </p>
                  <p>{review.action.fields.source_report_text}</p>
                  {renderLines(review.action.fields.entries)}
                </>
              )}
              {review?.action.line && (
                <>
                  <h3>{actionTitle(review.action)}</h3>
                  {renderLines([review.action.line])}
                </>
              )}
              {review?.action.kind === 'delete-line' && (
                <p>
                  {t('tsDeleteWarning')} {review.detail?.entries.find(e => e.id === review.action.entryId)?.work_date} ·{' '}
                  {review.detail?.entries.find(e => e.id === review.action.entryId)?.task}
                </p>
              )}
              {review?.action.kind === 'approve' && (
                <>
                  <p>
                    <strong>
                      {t(
                        review.action.decision === 'approved'
                          ? 'tsApprove'
                          : review.action.decision === 'rejected'
                            ? 'tsReject'
                            : 'tsReturn',
                      )}
                    </strong>
                    ：{review.action.comment}
                  </p>
                  <p>{t('tsApprovalBoundary')}</p>
                </>
              )}
              {norm && (
                <div className="oryh-ts-norm" data-phase={norm.phase}>
                  {(norm.phase === 'queued' || norm.phase === 'reviewing') && (
                    <p role="status">
                      {norm.phase === 'queued' ? '排队中，等待当前对话完成…' : '正在按企业工时流程要求核对…'}
                      {normElapsed >= 5 ? ` 已用时 ${normElapsed} 秒` : ''}
                    </p>
                  )}
                  {norm.phase === 'passed' && <p role="status">未发现与企业工时流程要求冲突。</p>}
                  {norm.phase === 'flagged' && (
                    <>
                      <p role="alert">{norm.message || '核对发现与企业工时流程要求存在冲突。'}</p>
                      <p className="muted">不符合企业工时流程要求，无法提交。请返回修改后重新提交。</p>
                    </>
                  )}
                  {norm.phase === 'unavailable' && (
                    <>
                      <p role="alert">无法完成规范核对，因此不能提交：{norm.message}</p>
                      <Button
                        size="small"
                        appearance="primary"
                        disabled={busy || !sessionId || !review?.action.headerId}
                        onClick={() =>
                          void run(async () => {
                            if (!sessionId || !review?.action.headerId) return
                            setNormError('')
                            setNormSince(Date.now())
                            await api.timesheetReviewStart(sessionId, review.action.headerId)
                          })
                        }
                      >
                        重新核对
                      </Button>
                    </>
                  )}
                </div>
              )}
            </DialogContent>
            {error && <p role="alert">{error}</p>}
            {busy && <p role="status">{t('tsLoading')}</p>}
            <DialogActions>
              <Button
                disabled={busy}
                onClick={() => {
                  setReview(undefined)
                  normReset()
                }}
              >
                {t('tsCancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={
                  busy ||
                  !review ||
                  review.expiresAt < Date.now() ||
                  (review.action.kind === 'submit' && norm?.phase !== 'passed')
                }
                onClick={() =>
                  void run(async () => {
                    if (!review) return
                    const n = await api.timesheetConfirm(
                      connection.id,
                      review.id,
                      review.revision,
                      review.token,
                      sessionId,
                    )
                    if (alive.current) {
                      setReview(undefined)
                      normReset()
                      setMessage(n.message)
                      setHistory(h => h.map(x => (x.id === n.id ? n : x)))
                      if (n.state === 'done') {
                        setDirty(false)
                        setEditor(false)
                        setEditing(undefined)
                        setDetail(undefined)
                      }
                    }
                    await refresh()
                    if (
                      n.state === 'done' &&
                      ['create', 'update', 'edit-line', 'add-line', 'delete-line'].includes(review.action.kind)
                    )
                      await open(review.action.headerId ?? n.resultId!)
                  })
                }
              >
                {t('tsConfirm')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  )
}
