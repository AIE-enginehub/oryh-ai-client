import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import {
  AskAi,
  Button,
  Dialog,
  ErrorNote,
  formatDateTime,
  type PageContext,
  type PageFace,
  PageHeader,
  type PageOwnerProps,
  RefreshButton,
  unwrap,
  useChatForms,
  usePane,
  useViewSharing,
} from '@oryh/ai-client-kit'
import type {
  CustomAskRequest,
  CustomForm,
  CustomFormConfirm,
  CustomFormPreview,
  CustomFormReceipt,
  CustomFormRequest,
  CustomIdRequest,
  CustomMigrationReport,
  CustomPage,
  CustomPageSummary,
  CustomRequest,
  CustomRun,
  CustomRunRequest,
  CustomSaveRequest,
} from '@oryh/dsh-analytics/types'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { customSrcDoc, type FrameTheme, type FrameWords, frameThemeCss, frameWords } from './custom-sandbox.js'
import { closedForms, FrameForm, type FrameFormReport, readFrameForms } from './frame-form.js'
import { type HarnessActions, type HarnessFormResult, HarnessPage } from './harness-page.js'
import type { Words } from './words.js'

const TOKENS = ['bg', 'surface', 'text', 'muted', 'line', 'accent', 'accent-soft', 'hover'] as const

/** A row of the page's own result by the path the frame names (`rows.3`), or undefined. */
function rowAt(data: unknown, path: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z_]\w{0,63}\.\d{1,5}(\.[A-Za-z_]\w{0,63}\.\d{1,5}){0,3}$/.test(path)) return undefined
  let current: unknown = data
  const parts = path.split('.')
  for (let index = 0; index < parts.length; index += 2) {
    const list =
      current && typeof current === 'object' ? (current as Record<string, unknown>)[parts[index]!] : undefined
    current = Array.isArray(list) ? list[Number(parts[index + 1])] : undefined
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
  }
  return current as Record<string, unknown>
}

/**
 * The workbench's theme as the page around the frame has it — its color tokens, font and light or dark
 * scheme — read from the element that defines them, and read again when the person switches theme.
 */
function useFrameTheme(anchor: RefObject<HTMLElement | null>): FrameTheme | undefined {
  const [theme, setTheme] = useState<FrameTheme>()
  useLayoutEffect(() => {
    const root = anchor.current?.closest<HTMLElement>('.client-root')
    if (!root) return
    const read = () => {
      const style = getComputedStyle(root)
      const tokens = Object.fromEntries(
        TOKENS.map(name => [name, style.getPropertyValue(`--${name}`).trim()] as const).filter(([, value]) => value),
      )
      const next: FrameTheme = {
        scheme: root.closest('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
        tokens,
        font: style.fontFamily,
      }
      setTheme(previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    }
    read()
    const observer = new MutationObserver(read)
    for (let element: HTMLElement | null = root; element; element = element.parentElement)
      observer.observe(element, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    return () => observer.disconnect()
  }, [anchor])
  return theme
}

export interface CustomApi {
  list(r: CustomRequest): Promise<CustomPageSummary[]>
  load(r: CustomIdRequest): Promise<CustomPage>
  save(r: CustomSaveRequest): Promise<CustomPage>
  run(r: CustomRunRequest): Promise<CustomPage>
  cancel(r: CustomIdRequest): Promise<void>
  restore(r: CustomRunRequest): Promise<CustomPage>
  delete(r: CustomRunRequest): Promise<void>
  migrate(r: CustomRequest): Promise<CustomMigrationReport>
  previewForm(r: CustomFormRequest): Promise<CustomFormPreview>
  submitForm(r: CustomFormConfirm): Promise<CustomFormReceipt>
  ask(r: CustomAskRequest): Promise<void>
}
export function createCustomApi(remote: ClientRemote, language?: () => string): CustomApi {
  const api = remote.oryhAnalytics
  return {
    list: r => unwrap(api.customList(r)),
    load: r => unwrap(api.customLoad(r)),
    save: r => unwrap(api.customSave(r)),
    run: r => unwrap(api.customRun({ ...r, language: language?.() ?? r.language })),
    cancel: r => unwrap(api.customCancel(r)),
    restore: r => unwrap(api.customRestore(r)),
    delete: r => unwrap(api.customDelete(r)),
    migrate: r => unwrap(api.customMigrate(r)),
    previewForm: r => unwrap(api.customFormPreview(r)),
    submitForm: r => unwrap(api.customFormSubmit(r)),
    ask: r => unwrap(api.customAsk({ ...r, language: language?.() ?? r.language })),
  }
}

/** What the frame needs of each form to lay it out: its fields and figures, never the instruction. */
function formSpecs(forms: readonly CustomForm[] | undefined) {
  return Object.fromEntries((forms ?? []).map(form => [form.name, { fields: form.fields, computed: form.computed }]))
}

function SourceReferences({ t, source }: { t: Words; source: NonNullable<CustomRun['sources']>[number] }) {
  const [all, setAll] = useState(false)
  const first = source.firstFetchedAt || source.fetchedAt
  const read = { source: source.path ?? source.collection, total: source.total, first: formatDateTime(first) }
  return (
    <details>
      <summary>
        {first !== source.fetchedAt
          ? t('customSourceSummaryRange', { ...read, last: formatDateTime(source.fetchedAt) })
          : t('customSourceSummary', read)}
      </summary>
      <p className="muted">
        {source.ids.length < source.total
          ? t('customSourceIdsPartial', { count: source.ids.length })
          : t('customSourceIds')}
      </p>
      <ul>
        {source.ids.slice(0, all ? undefined : 100).map(id => (
          <li key={id}>
            <code>{id}</code>
          </li>
        ))}
      </ul>
      {!all && source.ids.length > 100 && (
        <Button onClick={() => setAll(true)}>{t('customSourceMore', { count: source.ids.length - 100 })}</Button>
      )}
    </details>
  )
}

/** How long a refresh may take at most; the Host stops a run that goes past it. */
const RUN_LIMIT_SECONDS = 180

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * A refresh in progress, where it can be seen.
 *
 * A refresh is not a re-read: an agent carries the page's task out again, reading ORYH as it goes, and
 * that takes from half a minute to a few. One line of small print saying so left the page looking as if
 * the button had done nothing. This says what the run is doing now, how much it has read, and how long it
 * has been at it — the time moves every second, so there is always something moving — and keeps the way
 * to stop it beside that.
 * @param run - the page's run, with the Host's word on where it has got to.
 * @param hasResult - whether an earlier result stays on show underneath.
 */
function RunProgress({
  t,
  run,
  since,
  hasResult,
  onStop,
}: {
  t: Words
  run: CustomRun | undefined
  /** When the person asked for it here, for the moment before the run is on record. */
  since: number
  hasResult: boolean
  onStop(): void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const recorded = Date.parse(run?.startedAt ?? '')
  const started = Number.isFinite(recorded) ? recorded : since
  const elapsed = Math.max(0, Math.floor((now - started) / 1000))
  const progress = run?.progress
  return (
    <div className="oryh-run-progress" role="status" aria-live="polite">
      <span className="oryh-run-spinner" aria-hidden="true" />
      <div>
        <strong>{t('customRunTitle', { elapsed: clock(elapsed) })}</strong>
        <span>{progress?.step ?? t('customRunStarting')}</span>
        <span className="muted">
          {progress && (progress.requests > 0 || progress.rows > 0)
            ? t('customRunRead', { requests: progress.requests, rows: progress.rows })
            : ''}
          {t('customRunExplain', { minutes: RUN_LIMIT_SECONDS / 60 })}
          {hasResult ? t('customRunKeepsResult') : ''}
        </span>
        <progress
          max={RUN_LIMIT_SECONDS}
          value={Math.min(elapsed, RUN_LIMIT_SECONDS)}
          aria-label={t('customRunElapsed')}
        />
      </div>
      <Button onClick={onStop}>{t('customRunStop')}</Button>
    </div>
  )
}

export function CustomPageOwner(props: PageOwnerProps & { face: PageFace; t: Words; api: CustomApi }) {
  const { face, t } = props
  const sessionId = face.frame.sessionId
  const pane = usePane(face)
  const id = props.view?.id
  const sharing = useViewSharing(face, props.view)
  const [page, setPage] = useState<CustomPage>()
  const [busy, setBusy] = useState(false)
  /** When a refresh was last asked for from this page. */
  const [clicked, setClicked] = useState(() => Date.now())
  const [error, setError] = useState('')
  // A form submitted in the frame, waiting for the person to confirm what the agent is to be given.
  const [asking, setAsking] = useState<{
    request: number
    submission: CustomFormRequest
    preview: CustomFormPreview
  }>()
  const [sending, setSending] = useState(false)
  // Deleting a page cannot be undone, so it is asked about first — in the same dialog everything else is.
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  const anchor = useRef<HTMLElement>(null)
  const theme = useFrameTheme(anchor)
  const port = useRef<MessagePort>()
  // The frame says how tall its content is, so a long page scrolls with the pane instead of inside a box.
  const [frameHeight, setFrameHeight] = useState(560)
  // Whether a form on the page holds something typed: a framed page says so over its port, a Harness page
  // through its actions. Reported as the page's unsaved input, which Chat does not navigate away from.
  const [frameEditing, setFrameEditing] = useState(false)
  const [editingForms, setEditingForms] = useState<ReadonlySet<string>>(() => new Set())
  // The forms the page shows, as they describe themselves for `oryh_form_fill`: a Harness page's own
  // components, or — for a framed page — what its bridge reports of each form inside the frame.
  const [chatForms, setChatForms] = useState<NonNullable<PageContext['forms']>>([])
  const [frameForms, setFrameForms] = useState<FrameFormReport[]>([])
  const post = useCallback((message: Record<string, unknown>) => port.current?.postMessage(message), [])
  const nonce = useRef(crypto.randomUUID())
  const request = sessionId ? { sessionId, connectionId: props.connection.id } : undefined
  // Moves whenever the Host changes this page — an edit, a restore, a run starting or ending, from here
  // or from Chat — so the page shown is always the current version, never the one it first loaded.
  const revision = id ? pane.state.customPages?.[id] : undefined
  useEffect(() => {
    if (!id || !request || pane.status !== 'synced' || !props.active) return
    let alive = true
    setError('')
    void props.api.load({ ...request, id }).then(
      value => {
        if (alive) setPage(value)
      },
      reason => {
        if (alive) {
          setPage(undefined)
          setError(reason instanceof Error ? reason.message : t('customLoadFailed'))
        }
      },
    )
    return () => {
      alive = false
    }
  }, [id, sessionId, props.connection.id, pane.status, props.active, revision])
  const visible =
    page?.latest && page.latest.version === page.version && page.latest.status === 'succeeded' ? page.latest : undefined
  const running = busy || page?.run?.status === 'running'
  // The page's forms describe themselves to the agent, which can then fill them (docs/56 §15, §19). They
  // are on screen, and take a fill, only while a result is.
  const registry = useChatForms(face, {
    page: 'analytics',
    active: props.active && !!visible && !!page,
    onForms: setChatForms,
  })
  // Chat wrote to ORYH after this page's data was read: a custom page keeps a published result and does
  // not re-read by itself — a refresh is a run of its own — so it says so, and offers the refresh.
  const change = pane.state.serverChange
  const shownAt = Date.parse(visible?.endedAt ?? visible?.startedAt ?? '')
  const outdated = change !== undefined && Number.isFinite(shownAt) && change.at > shownAt
  // The frame's ready message can arrive at any moment after it mounts, so the listener stays for the
  // component's whole life and always sends the result on screen now, never one from an earlier render.
  const shown = useRef<{ data: unknown; forms: ReturnType<typeof formSpecs> }>({ data: null, forms: {} })
  shown.current = { data: visible?.data ?? null, forms: formSpecs(page?.definition.forms) }
  const themeCss = useRef('')
  themeCss.current = theme ? frameThemeCss(theme) : ''
  const frameSays = useRef<FrameWords>(frameWords(t))
  frameSays.current = frameWords(t)
  // A theme or language change updates only styles and words over the authenticated port; both keep the
  // typed form DOM intact instead of replacing the document.
  const frameDocument = useMemo(
    () => (page ? customSrcDoc(page, nonce.current, frameSays.current) : ''),
    [page?.id, page?.version, visible?.id],
  )
  const send = () => {
    port.current?.postMessage({ type: 'oryh-data', ...shown.current })
    if (themeCss.current) port.current?.postMessage({ type: 'oryh-theme', css: themeCss.current })
    port.current?.postMessage({ type: 'oryh-words', words: frameSays.current })
  }
  useEffect(() => {
    if (themeCss.current) post({ type: 'oryh-theme', css: themeCss.current })
  }, [theme, post])
  useEffect(() => {
    post({ type: 'oryh-words', words: frameWords(t) })
  }, [t, post])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'null' ||
        event.data?.type !== 'oryh-ready' ||
        event.data.nonce !== nonce.current ||
        event.ports.length !== 1
      )
        return
      port.current?.close()
      port.current = event.ports[0]
      // A frame that has just loaded holds nothing the person typed, whatever the one before it held.
      setFrameEditing(false)
      setFrameForms([])
      port.current!.onmessage = message => {
        const data = message.data as { type?: unknown; height?: unknown; dirty?: unknown; forms?: unknown } | null
        if (data?.type === 'oryh-editing') setFrameEditing(data.dirty === true)
        if (data?.type === 'oryh-forms') onFrameForms.current(data.forms)
        if (data?.type === 'oryh-height' && typeof data.height === 'number')
          setFrameHeight(Math.min(Math.max(Math.round(data.height), 200), 20_000))
        if (data?.type === 'oryh-form') onForm.current(data)
        if (data?.type === 'oryh-open' || data?.type === 'oryh-ask') onRowCommand.current(data)
      }
      send()
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      port.current?.close()
      port.current = undefined
    }
  }, [])
  useEffect(() => {
    if (visible) send()
  }, [visible?.id, page?.version])
  // What the frame says its forms hold, held to the page's declaration before anything reads it.
  const onFrameForms = useRef<(forms: unknown) => void>(() => {})
  onFrameForms.current = forms => setFrameForms(readFrameForms(forms, page?.definition.forms ?? []))
  // A framed page hears back on its port; a Harness page awaits its own promise, kept here by request number.
  const replies = useRef(new Map<number, (result: HarnessFormResult) => void>())
  const harnessRequests = useRef(1_000_000)
  const answer = (request: number, result: HarnessFormResult) => {
    const reply = replies.current.get(request)
    if (reply) {
      replies.current.delete(request)
      reply(result)
      return
    }
    port.current?.postMessage({ type: 'oryh-form-result', request, ...result })
  }
  // The frame says which form, which row and what was typed; the Host holds it to the form and says what
  // the agent would be given, and the person confirms it here, outside the frame and anything the model can call.
  const onForm = useRef<(message: unknown) => void>(() => {})
  onForm.current = message => {
    const {
      request: number,
      form,
      row,
      values,
    } = (message ?? {}) as {
      request?: unknown
      form?: unknown
      row?: unknown
      values?: unknown
    }
    if (typeof number !== 'number') return
    if (!page || !request || typeof form !== 'string' || typeof row !== 'string') {
      answer(number, { ok: false, message: t('customFormCannotSubmit') })
      return
    }
    if (asking || sending) {
      answer(number, { ok: false, message: t('customFormFinishPrevious') })
      return
    }
    const submission: CustomFormRequest = {
      ...request,
      id: page.id,
      expectedVersion: page.version,
      form,
      row,
      // Structured-cloned out of the frame: plain data. The Host holds every value to its declared field.
      values:
        values && typeof values === 'object' && !Array.isArray(values) ? (values as CustomFormRequest['values']) : {},
    }
    props.api.previewForm(submission).then(
      preview => setAsking({ request: number, submission, preview }),
      reason =>
        answer(number, { ok: false, message: reason instanceof Error ? reason.message : t('customFormCannotSubmit') }),
    )
  }
  // Opening a row's record and asking Chat about it: the frame names the row, the page reads it from its
  // own result. A record opens in ORYH itself, as every list's "打开 ORYH 完整记录" does.
  const onRowCommand = useRef<(message: unknown) => void>(() => {})
  onRowCommand.current = message => {
    const { type, target, question, row } = (message ?? {}) as Record<string, unknown>
    if (!page || !request || typeof row !== 'string') return
    if (type === 'oryh-open') {
      const match = typeof target === 'string' ? /^([a-z][a-z0-9_]{0,63}):([A-Za-z_]\w{0,63})$/.exec(target) : null
      const value = match ? rowAt(visible?.data, row)?.[match[2]!] : undefined
      if (!match || (typeof value !== 'string' && typeof value !== 'number') || String(value) === '') {
        setNotice(t('customRowNoRecord'))
        return
      }
      window.open(
        `${props.connection.origin}/console/objects/${match[1]}/${encodeURIComponent(String(value))}`,
        '_blank',
        'noopener,noreferrer',
      )
      return
    }
    if (type === 'oryh-ask' && typeof question === 'string')
      props.api.ask({ ...request, id: page.id, expectedVersion: page.version, question, row }).then(
        () => setNotice(t('customAskSent', { question })),
        reason => setNotice(reason instanceof Error ? reason.message : t('customAskNotSent')),
      )
  }
  // A Harness page asks for the same three things a framed page posts: a form, an open, an ask.
  const harnessActions: HarnessActions = {
    editing: (form, dirty) =>
      setEditingForms(current => {
        if (current.has(form) === dirty) return current
        const next = new Set(current)
        if (dirty) next.add(form)
        else next.delete(form)
        return next
      }),
    open: (row, target) => onRowCommand.current({ type: 'oryh-open', target, row }),
    ask: (row, question) => onRowCommand.current({ type: 'oryh-ask', question, row }),
    submit: (form, row, values) =>
      new Promise<HarnessFormResult>(resolve => {
        const request = ++harnessRequests.current
        replies.current.set(request, resolve)
        onForm.current({ request, form, row, values })
      }),
  }
  async function confirmForm() {
    if (!asking || sending) return
    setSending(true)
    const { request: number, submission, preview } = asking
    try {
      const receipt = await props.api.submitForm({ ...submission, digest: preview.digest })
      answer(number, { ok: true, message: receipt.message })
    } catch (reason) {
      answer(number, { ok: false, message: reason instanceof Error ? reason.message : t('customFormSubmitFailed') })
    } finally {
      setSending(false)
      setAsking(undefined)
    }
  }
  function cancelForm() {
    if (!asking || sending) return
    answer(asking.request, { ok: false, cancelled: true, message: t('customFormCancelled') })
    setAsking(undefined)
  }
  // The page's forms that are not on screen: a row's form is there once its row is opened.
  const closed = closedForms(
    page?.definition.forms ?? [],
    chatForms.map(form => form.id),
  )
  const closedKey = closed.join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `closedKey` is `closed`, by content.
  useEffect(() => {
    if (!props.active || !id) return
    props.onContext({
      key: `custom:${id}`,
      title: page?.definition.title ?? props.view?.label ?? t('pageTitle'),
      detail: running
        ? t('customContextRefreshing')
        : page?.run?.status === 'failed'
          ? t('customContextFailed')
          : visible
            ? t('customContextShown')
            : t('customContextWaiting'),
      scope: t('customContextScope'),
      content: JSON.stringify({
        id,
        version: page?.version,
        // How the page is written (docs/53): Harness components, or HTML in a frame.
        mode: page?.definition.mode,
        run: page?.run && { id: page.run.id, status: page.run.status, error: page.run.error },
        // The last result was read under grants the person no longer holds; a refresh reads again.
        ...(page?.withheld ? { withheld: t('customContextWithheld') } : {}),
        result: visible && {
          at: visible.endedAt,
          sources: visible.sources?.map(source => ({
            collection: source.collection,
            total: source.total,
            firstFetchedAt: source.firstFetchedAt,
            fetchedAt: source.fetchedAt,
          })),
          fields: Object.keys(visible.data ?? {}),
        },
        // Chat reads this on its next turn: what the person last submitted on the page, and where it stands.
        lastSubmission: page?.submission,
        error: error || undefined,
        // What the page tells the person now — a refresh an edit stopped, say — so Chat need not guess.
        notice: notice || undefined,
      }),
      // A form on the page holds something typed and not yet submitted, in either way of writing a page.
      ...(frameEditing || editingForms.size > 0 ? { unsaved: true } : {}),
      ...(chatForms.length > 0 ? { forms: chatForms } : {}),
      // And the forms it has that are not on screen, so the agent asks for the row to be opened
      // instead of saying the page cannot be filled.
      ...(closed.length > 0 ? { closedForms: closed } : {}),
    })
  }, [props.active, id, page, running, error, notice, frameEditing, editingForms, chatForms, closedKey, t])
  async function refresh() {
    if (!page || !request || running) return
    const began = Date.now()
    setBusy(true)
    setClicked(began)
    setError('')
    setNotice('')
    const version = page.version
    try {
      setPage(await props.api.run({ ...request, id: page.id, expectedVersion: version }))
      // Said once it is done: the data changing under the person is easy to miss.
      setNotice(t('customRefreshed', { elapsed: clock(Math.round((Date.now() - began) / 1000)) }))
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('customRefreshFailed')
      let current: CustomPage | undefined
      try {
        current = await props.api.load({ ...request, id: page.id })
        setPage(current)
      } catch {
        /* keep old result */
      }
      // Edited while it ran: the page has moved on to the new version, and the refresh stopping is what
      // an edit does, not a failure. An error left on the page also reads to Chat as the page not shown.
      if (current && current.version !== version) setNotice(t('customRefreshSuperseded'))
      else setError(message)
    } finally {
      setBusy(false)
    }
  }
  async function stop() {
    if (!page || !request) return
    try {
      await props.api.cancel({ ...request, id: page.id })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('customCancelFailed'))
    }
  }
  async function restore() {
    if (!page?.previous || !request || running) return
    setBusy(true)
    setError('')
    try {
      setPage(await props.api.restore({ ...request, id: page.id, expectedVersion: page.version }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('customRestoreFailed'))
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    if (!page || !request || running) return
    setDeleting(false)
    setBusy(true)
    setError('')
    try {
      await props.api.delete({ ...request, id: page.id, expectedVersion: page.version })
      setPage(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('customDeleteFailed'))
    } finally {
      setBusy(false)
    }
  }
  // Whose the page is comes with the page once it has loaded, and with its menu entry before that.
  const theirs = page?.sharedFrom !== undefined || props.view?.origin === 'shared'
  return (
    <section ref={anchor} className="oryh-analysis" aria-label={t('pageTitle')}>
      <PageHeader
        title={page?.definition.title ?? props.view?.label ?? t('pageTitle')}
        note={[
          visible
            ? t('customGeneratedAt', { time: formatDateTime(visible.endedAt ?? visible.startedAt) })
            : t('customNoResultNote'),
          sharing.note,
          page?.sharedFrom?.changed
            ? t('customSharedUpdated', {
                author: page.sharedFrom.author,
                time: formatDateTime(page.sharedFrom.updatedAt),
              })
            : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            {/* The agent reads this page beside the question, so "这个页面" needs no retelling. */}
            {page && <AskAi face={face} question={t('customPageQuestion')} />}
            {sharing.action}
            <RefreshButton
              t={face.frame.t}
              disabled={!page || running || pane.status !== 'synced'}
              onClick={() => void refresh()}
            />
            {/* A colleague's page is not the person's to undo or delete: its author's changes are followed,
                and it goes when its author withdraws it. A copy made on purpose is theirs. */}
            {!theirs && page?.previous && (
              <Button disabled={running} onClick={() => void restore()}>
                {t('customRestore')}
              </Button>
            )}
            {!theirs && (
              <Button disabled={running || !page} onClick={() => setDeleting(true)}>
                {t('customDelete')}
              </Button>
            )}
          </>
        }
      />
      {sharing.error}
      {error && <ErrorNote face={face} message={error} />}
      {page?.run?.status === 'failed' && (
        <ErrorNote
          face={face}
          message={t('customLastRefreshFailed', { error: page.run.error ?? t('customRunFailed') })}
        />
      )}
      {running && (
        <RunProgress
          t={t}
          // The page's own record of the run arrives a moment after the click; until then the click is the start.
          run={page?.run?.status === 'running' ? page.run : undefined}
          since={clicked}
          hasResult={!!visible}
          onStop={() => void stop()}
        />
      )}
      {page?.withheld === 'grants' && !running && (
        <p role="status" className="muted">
          {t('customWithheld')}
        </p>
      )}
      {outdated && !running && (
        <p role="status" className="oryh-outdated">
          {t('customOutdated')}
          <Button size="sm" disabled={pane.status !== 'synced'} onClick={() => void refresh()}>
            {t('customOutdatedRefresh')}
          </Button>
        </p>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {page?.submission?.status === 'sent' && (
        <p role="status" className="muted">
          {t('customSubmissionSent', { label: page.submission.label, id: page.submission.id })}
        </p>
      )}
      {/* Once dealt with, and only while the result shown was read before it: a refresh since then has it. */}
      {page?.submission?.status === 'done' && !(visible?.startedAt && visible.startedAt > page.submission.at) && (
        <p role="status" className="muted">
          {t('customSubmissionDone', { label: page.submission.label, id: page.submission.id })}
        </p>
      )}
      <Dialog
        open={deleting && !!page}
        onClose={() => setDeleting(false)}
        title={t('customDeleteTitle')}
        closeLabel={face.frame.t('dialogClose')}
        actions={
          <>
            <Button onClick={() => setDeleting(false)}>{t('customDeleteCancel')}</Button>
            <Button variant="primary" onClick={() => void remove()}>
              {t('customDeleteConfirmButton')}
            </Button>
          </>
        }
      >
        <p>{t('customDeleteConfirm', { title: page?.definition.title ?? '' })}</p>
      </Dialog>
      <Dialog
        open={!!asking}
        onClose={cancelForm}
        title={asking?.preview.label ?? ''}
        closeLabel={face.frame.t('dialogClose')}
        className="oryh-dialog-wide"
        actions={
          <>
            <Button disabled={sending} onClick={cancelForm}>
              {t('customConfirmCancel')}
            </Button>
            <Button variant="primary" disabled={sending} onClick={() => void confirmForm()}>
              {sending ? t('customConfirmSending') : t('customConfirmSubmit')}
            </Button>
          </>
        }
      >
        {!!asking?.preview.entries.length && (
          <dl className="oryh-form-entries">
            {asking.preview.entries.map(entry => (
              <div key={entry.label}>
                <dt className="muted">{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {asking?.preview.lines.map(lines => (
          <div key={lines.label}>
            <p className="muted">{lines.label}</p>
            <table className="oryh-form-lines">
              <thead>
                <tr>
                  {lines.columns.map(column => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.rows.map((row, index) => (
                  // Lines have no identity of their own: their place is what tells them apart here.
                  <tr key={index}>
                    {row.map((cell, column) => (
                      <td key={lines.columns[column]}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {!!asking?.preview.computed.length && (
          <p>
            {asking.preview.computed
              .map(item => t('customConfirmComputed', { label: item.label, value: item.value }))
              .join(t('customConfirmJoin'))}
            <span className="muted">{t('customConfirmComputedNote')}</span>
          </p>
        )}
        <p className="muted">{t('customConfirmHint')}</p>
        {/* What the agent is told to do with it was written for the agent; it is there to be read, not in the way. */}
        {asking?.preview.instruction ? (
          <details className="muted" open={!!page?.sharedFrom}>
            <summary>{t('customConfirmInstructionSummary')}</summary>
            <p>{asking.preview.instruction}</p>
          </details>
        ) : null}
      </Dialog>
      {visible && page ? (
        <>
          {/* Folded: one line a read, and a page may read dozens, all above what the page shows. */}
          {visible.sources?.length ? (
            <details className="muted">
              <summary>{t('customSources', { count: visible.sources.length })}</summary>
              <p>{t('customSourcesHint')}</p>
              {
                // Keyed by the read, not the collection: a list and each of its records' details share one
                // collection, and a shared key had React keep the last result's entries beside the new ones.
                visible.sources.map((source, index) => (
                  <SourceReferences
                    t={t}
                    key={`${index}:${source.name ?? source.path ?? source.collection}`}
                    source={source}
                  />
                ))
              }
            </details>
          ) : (
            <p className="muted">{t('customNoSources')}</p>
          )}
          {page.definition.mode === 'harness' ? (
            <HarnessPage
              blocks={page.definition.blocks ?? []}
              data={(visible.data ?? {}) as Record<string, unknown>}
              forms={page.definition.forms ?? []}
              fixedText={page.definition.fixedText ?? ''}
              actions={harnessActions}
              face={face}
              t={t}
              registry={registry}
              written={change?.records ?? []}
            />
          ) : (
            <>
              {/* Each form inside the frame has its stand-in out here: what Chat reads, fills and takes back. */}
              {frameForms.map(report => {
                const form = page.definition.forms?.find(candidate => candidate.name === report.name)
                return form ? (
                  <FrameForm
                    key={report.id}
                    face={face}
                    t={t}
                    registry={registry}
                    report={report}
                    form={form}
                    data={(visible.data ?? {}) as Record<string, unknown>}
                    post={post}
                  />
                ) : null
              })}
              <iframe
                // Definition and result versions replace the document; appearance changes do not.
                key={`${page.id}:${page.version}:${visible.id}`}
                ref={frame}
                title={page.definition.title}
                // allow-forms only lets the submit event fire: the bridge cancels it and the CSP refuses any
                // form target, so a form's values leave the frame through the Host's confirmation alone.
                sandbox="allow-scripts allow-forms"
                referrerPolicy="no-referrer"
                srcDoc={frameDocument}
                style={{ width: '100%', height: frameHeight, border: 0, colorScheme: theme?.scheme ?? 'normal' }}
              />
            </>
          )}
        </>
      ) : (
        <p className="muted">{t('customNoResult')}</p>
      )}
    </section>
  )
}
