import type { ConnectionSummary } from '@oryh/ai-client-core'
import type { ExpenseDraft, ExpenseFields, ExpenseLine, ExpenseState } from '@oryh/ai-client-expenses'
import { EXPENSE_OBJECT_TYPE } from '@oryh/ai-client-expenses/contracts'
import {
  BackToList,
  BusinessSessionContext,
  Button,
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
  Input,
  Link,
  ListFooter,
  ListLoading,
  MessageBar,
  MessageBarBody,
  NewButton,
  type PageContext,
  PageHeader,
  RefreshButton,
  RowOpenCell,
  RowOpenHeader,
  Select,
  StatusPill,
  type StatusTone,
  statusLabel,
  Text,
  Textarea,
  useBusinessText,
  useOryhRemote,
  usePane,
  useServerRefresh,
  useText,
} from '@oryh/dsh-client-frame/client'
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { useExpensesApi } from './api.js'

function today(): string {
  return formatDate(new Date())
}
function newLine(category: string): ExpenseLine {
  return { expenseDate: today(), category, amount: '', merchant: '', invoiceNumber: '', notes: '' }
}
function blank(category: string): ExpenseFields {
  return { title: '', claimDate: today(), currency: 'CNY', items: [newLine(category)] }
}
/** Local states that wait on the person: a confirmation to give, or a result to reconcile. */
function draftTone(state: ExpenseState): StatusTone {
  return ['review-create', 'review-submit', 'unknown-create', 'unknown-submit', 'submitted'].includes(state)
    ? 'pending'
    : 'neutral'
}
function total(fields: ExpenseFields): string {
  const cents = fields.items.reduce((sum, row) => sum + Math.round((Number(row.amount) || 0) * 100), 0)
  return (cents / 100).toFixed(2)
}
/** Traditional expense editing and explicit confirmations; no model or automatic business writes. */
export function ExpensePanel({
  connection,
  onDirtyChange,
  onContext,
  newRequest = 0,
  tabs,
  active = true,
}: {
  connection: ConnectionSummary
  /** Whether the drafts view is on screen, so a change made in Chat is read when it is shown. */
  active?: boolean
  /** The page's views, shown under its title while the draft list is open. */
  tabs?: ReactNode
  onDirtyChange: (dirty: boolean) => void
  onContext?: (value: PageContext) => void
  newRequest?: number
}): ReactNode {
  const t = useBusinessText()
  const text = useText()
  const names: Record<ExpenseState, string> = {
    editing: t('text22'),
    'review-create': t('text96'),
    creating: t('text97'),
    created: t('text98'),
    'review-submit': t('text99'),
    submitting: t('text100'),
    submitted: t('text101'),
    'unknown-create': t('text102'),
    'unknown-submit': t('text103'),
  }
  const remote = useExpensesApi()
  const frame = useOryhRemote()
  const alive = useRef(true)
  const running = useRef(false)
  const dirtyRef = useRef(false)
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([])
  const [selected, setSelected] = useState<ExpenseDraft>()
  const [fields, setFields] = useState<ExpenseFields>(blank(''))
  const [categories, setCategories] = useState<
    {
      name: string
      title: string
    }[]
  >([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [dirty, setDirty] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [editor, setEditor] = useState(false)
  const [leaveAction, setLeaveAction] = useState<(() => void) | undefined>()
  const [draftSession, setDraftSession] = useState(0)
  const [draftPage, setDraftPage] = useState(1)
  const draftPages = Math.max(1, Math.ceil(drafts.length / 12)),
    currentDraftPage = Math.min(draftPage, draftPages)
  const contextCallback = useRef(onContext)
  contextCallback.current = onContext
  const lastNewRequest = useRef(0)
  const sessionId = useContext(BusinessSessionContext),
    reviewState = usePane().state.review
  const [normError, setNormError] = useState(''),
    [normSince, setNormSince] = useState(0),
    [, setNormTick] = useState(0)
  /**
   * Where the pre-submit norm review stands, for a submit confirmation only.
   *
   * `expense_claim` carries a workflow definition, so submitting it goes through the same gate as
   * a timesheet (docs/22): the verdict comes from the agent reading the tenant's own norms, and
   * only `passed` enables 确认.
   */
  const norm = (() => {
    if (selected?.confirmation?.action !== 'submit') return undefined
    if (normError) return { phase: 'unavailable' as const, message: normError }
    const state =
      reviewState && reviewState.objectType === EXPENSE_OBJECT_TYPE && reviewState.documentId === selected.id
        ? reviewState
        : undefined
    // Before the first frame arrives the review is already queued Host-side, so treat it as such.
    if (!state) return { phase: 'queued' as const, message: '' }
    return { phase: state.status, message: state.message ?? '' }
  })()
  const normRunning = norm?.phase === 'queued' || norm?.phase === 'reviewing'
  const normElapsed = normRunning && normSince ? Math.floor((Date.now() - normSince) / 1000) : 0
  useEffect(() => {
    if (!normRunning) return
    const timer = setInterval(() => setNormTick(n => n + 1), 1000)
    return () => clearInterval(timer)
  }, [normRunning])
  function normReset() {
    setNormError('')
    setNormSince(0)
    if (sessionId) void frame.reviewClear(sessionId).catch(() => {})
  }
  async function normStart(draftId: string) {
    setNormError('')
    setNormSince(Date.now())
    if (!sessionId) {
      setNormError('当前没有会话，无法进行规范核对。')
      return
    }
    try {
      await remote.expenseReviewStart(sessionId, draftId)
    } catch (e) {
      if (alive.current) setNormError(e instanceof Error ? e.message : '规范核对无法开始。')
    }
  }
  const editable = selected === undefined || selected.state === 'editing' || selected.state === 'review-create'
  useEffect(() => {
    alive.current = true
    void run(async () => {
      const [rows, options] = await Promise.all([
        remote.expenseList(connection.id),
        remote.expenseOptions(connection.id),
      ])
      if (alive.current) {
        setDrafts(rows)
        setCategories(options.categories)
      }
    })
    return () => {
      alive.current = false
      onDirtyChange(false)
    }
  }, [connection.id])
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (dirty || running.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', listener)
    return () => window.removeEventListener('beforeunload', listener)
  }, [dirty])
  useEffect(() => {
    contextCallback.current?.({
      key: editor ? `expense:${selected?.id ?? `new-${draftSession}`}` : 'expense-drafts',
      title: editor ? fields.title || t('text57') : t('text104'),
      detail: editor ? `${selected ? names[selected.state] : t('text105')}${dirty ? t('text106') : ''}` : t('text107'),
      scope: editor ? t('text108', { value0: fields.items.length }) : t('text109'),
      content: JSON.stringify({ editor, fields: editor ? fields : undefined, busy, dirty, state: selected?.state }),
    })
  }, [editor, selected?.id, selected?.state, fields, busy, dirty, draftSession])
  useEffect(() => {
    if (newRequest > lastNewRequest.current && !busy) {
      lastNewRequest.current = newRequest
      choose()
    }
  }, [newRequest, busy])
  /**
   * Local drafts are this page's own, but the claim a draft created lives in ORYH and may have been
   * submitted in Chat. So the list re-reads, and an open draft that created a claim asks the server
   * where it stands — a read, never a write. A draft with unsaved edits is left alone, and a mismatch
   * found in passing is not shown as an error: the draft's own 核对服务端结果 is where that is dealt with.
   */
  useServerRefresh(active, () => {
    void run(async () => {
      const rows = await remote.expenseList(connection.id)
      if (!alive.current) return
      setDrafts(rows)
      const open = rows.find(row => row.id === selected?.id)
      if (open?.claimId === undefined || dirtyRef.current) return
      try {
        accept(await remote.expenseReconcile(connection.id, open.id, open.revision))
      } catch {
        /* reported by the draft's own reconcile, not by a background refresh */
      }
    })
  })
  function leave(action: () => void) {
    if (dirty) setLeaveAction(() => action)
    else action()
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    onDirtyChange(true)
    try {
      await action()
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : t('text110'))
    } finally {
      running.current = false
      if (alive.current) {
        setBusy(false)
        onDirtyChange(dirtyRef.current)
      }
    }
  }
  function changed(value: ExpenseFields) {
    setFields(value)
    setDirty(true)
    dirtyRef.current = true
    onDirtyChange(true)
    setDialog(false)
  }
  function accept(value: ExpenseDraft) {
    if (!alive.current) return
    setSelected(value)
    setFields(value.fields)
    setDirty(false)
    dirtyRef.current = false
    onDirtyChange(false)
    setDrafts(rows => [value, ...rows.filter(row => row.id !== value.id)])
  }
  function choose(value?: ExpenseDraft) {
    leave(() => {
      setDraftSession(current => current + 1)
      setSelected(value)
      setFields(value?.fields ?? blank(categories[0]?.name ?? ''))
      setDirty(false)
      dirtyRef.current = false
      onDirtyChange(false)
      setEditor(true)
      setDialog(false)
      setError(undefined)
    })
  }
  function patchLine(index: number, changes: Partial<ExpenseLine>) {
    changed({ ...fields, items: fields.items.map((line, i) => (i === index ? { ...line, ...changes } : line)) })
  }
  async function upload(file: File, index: number) {
    if (file.size > 500 * 1024) throw new Error(t('text111'))
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(new Error(t('text112')))
      reader.readAsDataURL(file)
    })
    const attachment = await remote.expenseUpload(connection.id, {
      filename: file.name,
      contentType: file.type,
      contentBase64: encoded,
    })
    if (alive.current) patchLine(index, { attachment })
  }
  const panel = useRef<HTMLElement>(null)
  const listPosition = useRef(0)
  useEffect(() => {
    const seat = panel.current?.closest<HTMLElement>('.oryh-business-seat')
    if (!seat) return
    if (editor) {
      listPosition.current = seat.scrollTop
      seat.scrollTop = 0
    } else seat.scrollTop = listPosition.current
  }, [editor])
  return (
    <section ref={panel} className="expense-panel">
      {editor ? (
        <PageHeader
          back={
            <BackToList
              disabled={busy}
              onClick={() =>
                leave(() => {
                  setEditor(false)
                  setDirty(false)
                  dirtyRef.current = false
                  onDirtyChange(false)
                })
              }
            />
          }
          title={t('text113')}
          status={
            <StatusPill tone={selected && !dirty ? draftTone(selected.state) : 'neutral'}>
              {selected && !dirty ? names[selected.state] : t('text105')}
            </StatusPill>
          }
          note={dirty ? t('text126') : t('text114')}
        />
      ) : (
        <PageHeader
          title={text('text10')}
          note={t('text115')}
          tabs={tabs}
          actions={
            <>
              <RefreshButton
                disabled={busy || dirty}
                onClick={() => {
                  void run(async () => {
                    const rows = await remote.expenseList(connection.id)
                    if (alive.current) setDrafts(rows)
                  })
                }}
              />
              <NewButton disabled={busy} onClick={() => choose()}>
                {t('text57')}
              </NewButton>
            </>
          }
        />
      )}
      {busy && <ListLoading label={t('text118')} />}
      {error && <ErrorNote message={error} />}
      {!editor && (
        <div className="surface table-surface">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('text119')}</th>
                  <th scope="col">{t('text60')}</th>
                  <th scope="col">{t('text120')}</th>
                  <th scope="col">{t('text121')}</th>
                  <RowOpenHeader />
                </tr>
              </thead>
              <tbody>
                {drafts.slice((currentDraftPage - 1) * 12, currentDraftPage * 12).map(row => (
                  <tr key={row.id}>
                    <td>
                      <button className="record-link" disabled={busy} onClick={() => choose(row)}>
                        {row.fields.title || t('text122')}
                      </button>
                    </td>
                    <td>
                      <StatusPill tone={draftTone(row.state)}>{names[row.state]}</StatusPill>
                    </td>
                    <td className="numeric">
                      {row.fields.currency} {total(row.fields)}
                    </td>
                    <td className="numeric">{formatDate(row.updatedAt)}</td>
                    <RowOpenCell title={row.fields.title || t('text122')} disabled={busy} onOpen={() => choose(row)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {drafts.length === 0 && !busy && <EmptyState filtered={false} title={t('text123')} hint={t('text124')} />}
          <ListFooter
            count={drafts.length}
            page={currentDraftPage}
            pages={draftPages}
            disabled={busy}
            onPage={setDraftPage}
          />
        </div>
      )}
      {editor && (
        <div className="surface expense-editor">
          {selected?.message && (
            <MessageBar>
              <MessageBarBody>{selected.message}</MessageBarBody>
            </MessageBar>
          )}
          <h3 className="form-section-title">{t('text127')}</h3>
          <fieldset disabled={busy || !editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            <Field label={t('text119')} required>
              <Input
                value={fields.title}
                maxLength={200}
                onChange={(_, data) => changed({ ...fields, title: data.value })}
              />
            </Field>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Field label={t('text29')} required>
                <Input
                  type="date"
                  value={fields.claimDate}
                  onChange={(_, data) => changed({ ...fields, claimDate: data.value })}
                />
              </Field>
              <Field label={t('text77')} required>
                <Input
                  value={fields.currency}
                  maxLength={3}
                  onChange={(_, data) => changed({ ...fields, currency: data.value.toUpperCase() })}
                />
              </Field>
            </div>
            {fields.items.map((line, index) => (
              <section key={index} className="expense-line" aria-label={t('text128', { value0: index + 1 })}>
                <Text weight="semibold">
                  {t('text129')}
                  {index + 1}
                </Text>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                  <Field label={t('text130')} required>
                    <Input
                      type="date"
                      value={line.expenseDate}
                      onChange={(_, data) => patchLine(index, { expenseDate: data.value })}
                    />
                  </Field>
                  <Field label={t('text131')} required>
                    <Select
                      value={line.category}
                      onChange={event => patchLine(index, { category: event.target.value })}
                    >
                      <option value="">{t('text132')}</option>
                      {line.category && !categories.some(value => value.name === line.category) && (
                        <option value={line.category}>
                          {line.category}
                          {t('text133')}
                        </option>
                      )}
                      {categories.map(category => (
                        <option key={category.name} value={category.name}>
                          {category.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('text120')} required>
                    <Input
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(_, data) => patchLine(index, { amount: data.value })}
                    />
                  </Field>
                  <Field label={t('text134')}>
                    <Input
                      value={line.merchant}
                      maxLength={200}
                      onChange={(_, data) => patchLine(index, { merchant: data.value })}
                    />
                  </Field>
                  <Field label={t('text135')}>
                    <Input
                      value={line.invoiceNumber}
                      maxLength={100}
                      onChange={(_, data) => patchLine(index, { invoiceNumber: data.value })}
                    />
                  </Field>
                </div>
                <Field label={t('text136')}>
                  <Textarea
                    value={line.notes}
                    maxLength={2000}
                    onChange={(_, data) => patchLine(index, { notes: data.value })}
                  />
                </Field>
                <Field label={t('text137')}>
                  <input
                    aria-label={t('text138', { value0: index + 1 })}
                    type="file"
                    accept="application/pdf,image/png,image/jpeg"
                    onChange={event => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file) void run(() => upload(file, index))
                    }}
                  />
                </Field>
                {line.attachment && (
                  <Text>
                    {t('text139')}
                    {line.attachment.filename}
                  </Text>
                )}
                <Button
                  disabled={fields.items.length <= 1}
                  onClick={() => changed({ ...fields, items: fields.items.filter((_, i) => i !== index) })}
                >
                  {t('text140')}
                </Button>
              </section>
            ))}
            <Button
              disabled={fields.items.length >= 100}
              onClick={() => changed({ ...fields, items: [...fields.items, newLine(categories[0]?.name ?? '')] })}
            >
              {t('text141')}
            </Button>
          </fieldset>
          <Text weight="semibold">
            {t('text142')}
            {fields.currency} {total(fields)}
          </Text>
          <div className="form-actions">
            {editable && (
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  void run(async () =>
                    accept(
                      await remote.expenseSave(connection.id, {
                        ...(selected ? { id: selected.id, revision: selected.revision } : {}),
                        fields,
                      }),
                    ),
                  )
                }}
              >
                {t('text143')}
              </Button>
            )}
            {dirty && (
              <Button
                disabled={busy}
                onClick={() => {
                  setFields(selected?.fields ?? blank(categories[0]?.name ?? ''))
                  setDirty(false)
                  dirtyRef.current = false
                  onDirtyChange(false)
                  setDialog(false)
                }}
              >
                {t('text144')}
              </Button>
            )}
            {selected && ['editing', 'review-create', 'created', 'review-submit'].includes(selected.state) && (
              <Button
                disabled={busy || dirty}
                onClick={() => {
                  void run(async () => {
                    const value = await remote.expensePrepare(connection.id, selected.id, selected.revision)
                    accept(value)
                    if (alive.current && value.confirmation) setDialog(true)
                    if (alive.current && value.confirmation?.action === 'submit') await normStart(selected.id)
                  })
                }}
              >
                {selected.claimId ? t('text145') : t('text146')}
              </Button>
            )}
            {selected && ['unknown-create', 'unknown-submit', 'created', 'submitted'].includes(selected.state) && (
              <Button
                disabled={busy || dirty}
                onClick={() => {
                  void run(async () =>
                    accept(await remote.expenseReconcile(connection.id, selected.id, selected.revision)),
                  )
                }}
              >
                {t('text147')}
              </Button>
            )}
            {selected && ['editing', 'review-create', 'submitted'].includes(selected.state) && (
              <Button
                disabled={busy || dirty}
                onClick={() => {
                  void run(async () => {
                    await remote.expenseDelete(connection.id, selected.id, selected.revision)
                    if (alive.current) {
                      setDrafts(rows => rows.filter(row => row.id !== selected.id))
                      setSelected(undefined)
                      setEditor(false)
                    }
                  })
                }}
              >
                {t('text148')}
              </Button>
            )}
          </div>
          {selected?.claimId && (
            <div>
              <Text>
                {t('text149')}
                {selected.claimId}
                {t('text150')}
                {selected.serverStatus ? statusLabel(selected.serverStatus) : '—'}
              </Text>
              <br />
              <Link
                href={`${connection.origin}/console/objects/expense_claim/${encodeURIComponent(selected.claimId)}`}
                target="_blank"
                rel="noreferrer"
              >
                {t('text151')}
              </Link>
            </div>
          )}
          <Dialog
            open={dialog}
            onOpenChange={(_, data) => {
              if (!busy) {
                setDialog(data.open)
                if (!data.open) normReset()
              }
            }}
          >
            <DialogSurface>
              <DialogBody>
                <DialogTitle>{selected?.confirmation?.action === 'submit' ? t('text152') : t('text153')}</DialogTitle>
                <DialogContent>
                  <p>
                    {connection.identity.tenant.name ?? connection.identity.tenant.slug} ·{' '}
                    {connection.identity.user.email}
                  </p>
                  <p>
                    <strong>{fields.title}</strong> · {fields.claimDate} · {fields.currency} {total(fields)}
                  </p>
                  <ul>
                    {fields.items.map((line, index) => (
                      <li key={index}>
                        {line.expenseDate} ·{' '}
                        {categories.find(value => value.name === line.category)?.title ?? line.category} · {line.amount}{' '}
                        · {line.merchant || t('text154')}
                        {t('text155')}
                        {line.invoiceNumber || t('text156')} · {line.attachment?.filename ?? t('text157')}
                        {line.notes && <p>{line.notes}</p>}
                      </li>
                    ))}
                  </ul>
                  <p>{selected?.confirmation?.action === 'submit' ? t('text158') : t('text159')}</p>
                  <p>{t('text160')}</p>
                  {norm && (
                    <div className="oryh-ts-norm" data-phase={norm.phase}>
                      {(norm.phase === 'queued' || norm.phase === 'reviewing') && (
                        <p role="status">
                          {norm.phase === 'queued' ? '排队中，等待当前对话完成…' : '正在按企业费用报销流程要求核对…'}
                          {normElapsed >= 5 ? ` 已用时 ${normElapsed} 秒` : ''}
                        </p>
                      )}
                      {norm.phase === 'passed' && <p role="status">未发现与企业费用报销流程要求冲突。</p>}
                      {norm.phase === 'flagged' && (
                        <>
                          <p role="alert">{norm.message || '核对发现与企业费用报销流程要求存在冲突。'}</p>
                          <p className="muted">不符合企业费用报销流程要求，无法提交。请返回修改后重新提交。</p>
                        </>
                      )}
                      {norm.phase === 'unavailable' && (
                        <>
                          <p role="alert">无法完成规范核对，因此不能提交：{norm.message}</p>
                          <Button
                            size="small"
                            appearance="primary"
                            disabled={busy || !sessionId || !selected}
                            onClick={() => {
                              if (selected) void normStart(selected.id)
                            }}
                          >
                            重新核对
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setDialog(false)
                      normReset()
                    }}
                  >
                    {t('text161')}
                  </Button>
                  <Button
                    appearance="primary"
                    disabled={
                      busy ||
                      !selected?.confirmation ||
                      (selected.confirmation.action === 'submit' && norm?.phase !== 'passed')
                    }
                    onClick={() => {
                      if (selected?.confirmation)
                        void run(async () => {
                          const value = await remote.expenseConfirm(
                            connection.id,
                            selected.id,
                            selected.revision,
                            selected.confirmation!.token,
                            sessionId,
                          )
                          accept(value)
                          if (alive.current) {
                            setDialog(false)
                            normReset()
                          }
                        })
                    }}
                  >
                    {t('text162')}
                    {selected?.confirmation?.action === 'submit' ? t('text163') : t('text164')}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      )}
      <Dialog
        open={leaveAction !== undefined}
        onOpenChange={(_, data) => {
          if (!data.open && !busy) setLeaveAction(undefined)
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('text165')}</DialogTitle>
            <DialogContent>
              {t('text166')}
              {error && <p role="alert">{error}</p>}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setLeaveAction(undefined)}>
                {t('text167')}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  const action = leaveAction
                  setLeaveAction(undefined)
                  action?.()
                }}
              >
                {t('text168')}
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    const draft = await remote.expenseSave(connection.id, {
                      ...(selected ? { id: selected.id, revision: selected.revision } : {}),
                      fields,
                    })
                    accept(draft)
                    const action = leaveAction
                    setLeaveAction(undefined)
                    action?.()
                  })
                }}
              >
                {t('text169')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <p className="data-caption">{t('text170')}</p>
    </section>
  )
}
