import type { ConnectionSummary } from '@oryh/ai-client-core'
import {
  Button,
  columnPreferenceScope,
  Dialog,
  Field,
  Input,
  LinkButton,
  LocalRemoteError,
  Notice,
  noUserViews,
  Select,
  Spinner,
  viewGranted,
} from '@oryh/ai-client-kit'
import { type BusinessCopy, useBusinessCopy } from '@oryh/ai-client-kit/dictionary'
import { allowedPages } from '@oryh/ai-client-pages'
import { OryhWorkspace, type OryhWorkspaceSnapshot } from '@oryh/ai-client-workspace'
import { IconDeviceDesktop } from '@tabler/icons-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BusinessView, FrameIdentity } from './layout-store.js'
import { enterAgainIfLost, isFinalFailure, retryDelay } from './permission-check.js'
import { restoreStartupConnection } from './startup-connection.js'
import { type FrameEnv, Workbench } from './workbench.js'

const authStyles = {
  intro: 'connect-intro',
  card: 'auth-card',
  connectForm: 'connect-form',
  approval: 'approval',
  cardTitle: 'card-title',
  code: 'device-code',
  inlineStatus: 'inline-status',
  resultToolbar: 'toolbar',
}
type AuthStyles = typeof authStyles
type BusyAction = 'load' | 'connect' | 'run' | undefined
/** How stale the verified grants may be before returning to the window asks ORYH again. */
const REVERIFY_AFTER_MS = 5 * 60_000
export function App({
  env,
  dark,
  page,
  onIdentity,
}: {
  /** What the frame's entry was drawn with, handed on to whatever needs it. */
  env: FrameEnv
  dark: boolean
  page: BusinessView
  onIdentity: (identity: FrameIdentity | undefined) => void
}): ReactNode {
  const { t, remote } = env
  const copy = useBusinessCopy(t)
  const styles = authStyles
  const workspace = useMemo(() => new OryhWorkspace(remote), [remote])
  const [snapshot, setSnapshot] = useState<OryhWorkspaceSnapshot>(() => workspace.snapshot())
  const actionGeneration = useRef(0)
  const startupRecovery = useRef<AbortController | undefined>(undefined)
  const [startupRetrying, setStartupRetrying] = useState(false)
  const [expenseDirty, setExpenseDirty] = useState(false)
  const [busy, setBusy] = useState<BusyAction>('load')
  const [error, setError] = useState<string | undefined>()
  const [origin, setOrigin] = useState('')
  /** Where this deployment signs people out, when it is the one holding the sign-in (the server). */
  const [signOut, setSignOut] = useState<string>()
  /** Where this single-user client is handed to another account, when its deployment lets the person. */
  const [switchAccount, setSwitchAccount] = useState<string>()
  useEffect(() => {
    let live = true
    void remote
      .connectionDefaults()
      .then(defaults => {
        if (!live) return
        setOrigin(current => current || defaults.origin)
        setSignOut(defaults.signOut)
        setSwitchAccount(defaults.switchAccount)
      })
      .catch(() => {
        /* A default is optional; users can still enter their server. */
      })
    return () => {
      live = false
    }
  }, [remote])
  const [changingServer, setChangingServer] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const isDark = dark
  const selectedConnection =
    snapshot.activeConnectionId === undefined
      ? undefined
      : snapshot.connections.find(connection => connection.id === snapshot.activeConnectionId)
  const [verified, setVerified] = useState<ConnectionSummary>()
  const [accessError, setAccessError] = useState(false)
  /** Asks again now; what the pane's own "retry" does. */
  const recheck = useRef<() => void>(() => {})
  useEffect(() => {
    let live = true,
      running = false,
      verifiedAt = 0,
      failures = 0,
      retry: number | undefined
    setVerified(undefined)
    setAccessError(false)
    const refresh = async () => {
      if (!selectedConnection || running) return
      running = true
      if (retry !== undefined) window.clearTimeout(retry)
      retry = undefined
      try {
        const next = await remote.verifyConnection(selectedConnection.id)
        verifiedAt = Date.now()
        failures = 0
        if (live) {
          setVerified(next)
          setAccessError(false)
        }
      } catch (reason) {
        if (!live) return
        if (isFinalFailure(reason)) {
          // An answer about the person: this is not them any more, or their sign-in is gone.
          setVerified(undefined)
          setAccessError(true)
          return
        }
        // A failure to ask (permission-check.ts): what was verified stays, and the question is put again
        // shortly. The pane says so only where nothing was ever verified to show in the meantime.
        failures++
        setAccessError(true)
        retry = window.setTimeout(() => void refresh(), retryDelay(failures))
        // On the server version a restarted control process no longer knows this page: asking again
        // would be refused for good, and the page said "retrying" for as long as it stayed open. Entering
        // again is what recovers, without a new sign-in — so the page does it itself.
        if (failures >= 2) void enterAgainIfLost()
      } finally {
        running = false
      }
    }
    recheck.current = () => void refresh()
    void refresh()
    // No timer while all is well: a person who is away needs no fresh grants, and every page read is
    // checked by the Host and by ORYH anyway. Coming back to the window after a while asks once.
    const focus = () => {
      if (Date.now() - verifiedAt >= REVERIFY_AFTER_MS) void refresh()
    }
    window.addEventListener('focus', focus)
    return () => {
      live = false
      if (retry !== undefined) window.clearTimeout(retry)
      window.removeEventListener('focus', focus)
    }
  }, [selectedConnection?.id, remote])
  const activeConnection = selectedConnection
  const permittedConnection =
    verified &&
    activeConnection &&
    verified.id === activeConnection.id &&
    columnPreferenceScope(verified) === columnPreferenceScope(activeConnection)
      ? verified
      : undefined
  const permittedPages = permittedConnection ? allowedPages(permittedConnection.identity) : ['settings']
  const allowedKey = permittedPages.join(',')
  // Only once verified. An entry the person made is theirs to see; whether ORYH lets them read what it
  // lists is answered when the list is read. An entry their role implies shows while the role grants it.
  const { views: userViews } =
    env.useMenu(permittedConnection ? columnPreferenceScope(permittedConnection) : '') ?? noUserViews
  const menuViews = userViews
    .filter(v => (permittedConnection ? viewGranted(permittedConnection.identity, v) : false))
    .map(({ id, label, collection, origin, sharedBy }) => ({
      id,
      label,
      collection,
      ...(origin ? { origin } : {}),
      ...(sharedBy ? { sharedBy } : {}),
    }))
  const menuViewsKey = JSON.stringify(menuViews)
  // Known before the grants are: the frame brings this person's last page back while they are verified.
  const scope = activeConnection ? columnPreferenceScope(activeConnection) : undefined
  const company = activeConnection ? tenantName(activeConnection) : undefined
  const email = activeConnection?.identity.user.email
  const askSignOut = useCallback(() => setSignOutOpen(true), [])
  // The gateway's page says who is signed in and what switching does before anything changes.
  const goSwitchAccount = useCallback(() => {
    if (switchAccount !== undefined) window.location.assign(switchAccount)
  }, [switchAccount])
  useEffect(() => {
    onIdentity(
      scope && company && email
        ? {
            scope,
            company,
            email,
            allowedPages: permittedPages,
            views: menuViews,
            ...(signOut === undefined ? {} : { signOut: askSignOut }),
            ...(switchAccount === undefined ? {} : { switchAccount: goSwitchAccount }),
          }
        : undefined,
    )
    return () => onIdentity(undefined)
  }, [scope, company, email, onIdentity, allowedKey, menuViewsKey, signOut, askSignOut, switchAccount, goSwitchAccount])
  const apply = useCallback(
    async (action: () => Promise<void>, nextBusy: BusyAction) => {
      startupRecovery.current?.abort()
      startupRecovery.current = undefined
      const generation = ++actionGeneration.current
      setBusy(nextBusy)
      setStartupRetrying(false)
      setError(undefined)
      try {
        const pending = action()
        setSnapshot(workspace.snapshot())
        await pending
      } catch (reason) {
        if (
          generation === actionGeneration.current &&
          !(
            reason instanceof Error &&
            (reason.name === 'AbortError' || ('code' in reason && reason.code === 'stale-request'))
          )
        ) {
          setError(messageFor(reason, copy))
        }
      } finally {
        if (generation === actionGeneration.current) {
          setSnapshot(workspace.snapshot())
          setBusy(undefined)
        }
      }
    },
    [workspace],
  )
  useEffect(() => {
    let recovery: AbortController | undefined
    void apply(async () => {
      recovery = new AbortController()
      startupRecovery.current = recovery
      await restoreStartupConnection(
        async () => {
          const defaults = await remote.connectionDefaults()
          return workspace.load(defaults.activeConnectionId)
        },
        recovery.signal,
        () => setStartupRetrying(true),
      )
    }, 'load')
    return () => {
      recovery?.abort()
      if (startupRecovery.current === recovery) startupRecovery.current = undefined
    }
  }, [apply, workspace])
  useEffect(() => {
    const pending = snapshot.pendingConnection
    if (pending === undefined) return
    let disposed = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const outcome = await workspace.pollConnection()
        if (!disposed && outcome.state === 'connected') setChangingServer(false)
        if (!disposed) setSnapshot(workspace.snapshot())
      } catch (reason) {
        if (reason instanceof Error && 'code' in reason && reason.code === 'stale-request') return
        if (!disposed) {
          setError(messageFor(reason, copy))
          // The attempt ended with the error; the page goes back to offering a new one.
          setSnapshot(workspace.snapshot())
        }
        return
      }
      if (!disposed && workspace.snapshot().pendingConnection !== undefined) {
        timer = window.setTimeout(() => {
          void poll()
        }, pending.prompt.pollIntervalSeconds * 1000)
      }
    }
    timer = window.setTimeout(() => {
      void poll()
    }, pending.prompt.pollIntervalSeconds * 1000)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [snapshot.pendingConnection?.authorizationId, workspace])
  const savedConnections = (
    <>
      {snapshot.connections.length > 1 && (
        <Field label={t('text1')}>
          <Select
            aria-label={copy.chooseConnection}
            disabled={expenseDirty || busy !== undefined}
            value={snapshot.activeConnectionId ?? ''}
            onChange={event => {
              void apply(async () => {
                await workspace.selectConnection(event.target.value as ConnectionSummary['id'])
              }, 'load')
            }}
          >
            <option value="" disabled>
              {copy.chooseConnection}
            </option>
            {snapshot.connections.map(connection => (
              <option key={connection.id} value={connection.id}>
                {tenantName(connection)} · {connection.identity.user.email} · {connection.origin}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  )
  const connectionControls = (
    <>
      {savedConnections}
      {/* Connecting is the desktop's. On a
          deployment that signed them in, the one thing to offer is the way out. */}
      {signOut === undefined && switchAccount === undefined && (
        <div className="connection-action">
          <h3>{copy.connectAnotherAccount}</h3>
          <p>{copy.changeAccountDescription}</p>
          {/* A second account is refused by a single-user container's owner check: there, switching is offered. */}
          {activeConnection && !snapshot.pendingConnection && switchAccount === undefined && (
            <Button
              disabled={busy !== undefined || expenseDirty}
              onClick={() => {
                setOrigin(activeConnection.origin)
                void apply(async () => {
                  await workspace.beginConnection(activeConnection.origin, copy.productName)
                }, 'connect')
              }}
            >
              {copy.connectAnotherAccount}
            </Button>
          )}
        </div>
      )}
      {switchAccount !== undefined && (
        <div className="disconnect-section">
          <p>{copy.switchAccountDescription}</p>
          <Button disabled={busy !== undefined || expenseDirty} onClick={goSwitchAccount}>
            {copy.switchAccount}
          </Button>
        </div>
      )}
      {activeConnection && signOut === undefined && (
        <div className="disconnect-section">
          <h3>{copy.changeServer}</h3>
          <p>{switchAccount === undefined ? copy.changeServerDescription : copy.changeServerRedirectDescription}</p>
          <Button
            disabled={busy !== undefined || expenseDirty || snapshot.pendingConnection !== undefined}
            onClick={() => {
              if (switchAccount !== undefined) {
                goSwitchAccount()
                return
              }
              setOrigin('')
              setChangingServer(true)
            }}
          >
            {copy.changeServer}
          </Button>
        </div>
      )}
    </>
  )
  const notices = (
    <>
      {error && (
        <Notice
          intent="error"
          actions={
            <Button
              size="sm"
              disabled={expenseDirty || busy !== undefined}
              onClick={() => {
                void apply(async () => {
                  await workspace.load()
                }, 'load')
              }}
            >
              {t('text4')}
            </Button>
          }
        >
          {error}
        </Notice>
      )}
      {activeConnection && !changingServer && snapshot.pendingConnection && (
        <DeviceAuthorization
          copy={copy}
          styles={styles}
          pending={snapshot.pendingConnection}
          busy={busy}
          switchingAccount
          onCancel={() => {
            void apply(async () => {
              await workspace.cancelConnection()
            }, 'connect')
          }}
        />
      )}
    </>
  )
  return (
    <div className="client-root" data-theme={isDark ? 'dark' : 'light'}>
      {activeConnection && !changingServer ? (
        !permittedConnection && page !== 'settings' ? (
          <main className="business-content">
            {accessError ? (
              <p role="status">
                {t('verifyRetrying')}{' '}
                <Button size="sm" onClick={() => recheck.current()}>
                  {t('verifyRetryNow')}
                </Button>
              </p>
            ) : (
              <p role="status">{t('verifying')}</p>
            )}
          </main>
        ) : (
          <Workbench
            env={env}
            key={`${activeConnection.id}:${activeConnection.identity.tenant.id}:${activeConnection.identity.user.id}:${activeConnection.identity.user.employeeId}`}
            page={page}
            connection={
              permittedConnection ?? {
                ...activeConnection,
                identity: { ...activeConnection.identity, permissions: [] },
              }
            }
            onDirtyChange={setExpenseDirty}
            settings={connectionControls}
            notices={notices}
          />
        )
      ) : (
        <main className="connection-screen">
          <div className="connection-brand">
            ORYH <span>{t('text5')}</span>
          </div>
          {changingServer && (
            <>
              <Button
                disabled={busy !== undefined}
                onClick={() => {
                  void apply(async () => {
                    if (snapshot.pendingConnection) await workspace.cancelConnection()
                    setChangingServer(false)
                  }, 'connect')
                }}
              >
                {copy.cancelServerChange}
              </Button>
            </>
          )}
          {notices}
          {busy === 'load' ? (
            <Spinner label={t(startupRetrying ? 'verifyRetrying' : 'text6')} />
          ) : (
            <>
              {!activeConnection && snapshot.pendingConnection === undefined && savedConnections}
              <ConnectView
                changingServer={changingServer}
                t={t}
                copy={copy}
                styles={styles}
                origin={origin}
                pending={snapshot.pendingConnection}
                busy={busy}
                onOriginChange={setOrigin}
                onBegin={() => {
                  void apply(async () => {
                    await workspace.beginConnection(origin.trim(), copy.productName)
                  }, 'connect')
                }}
                onCancel={() => {
                  void apply(async () => {
                    await workspace.cancelConnection()
                  }, 'connect')
                }}
              />
            </>
          )}
        </main>
      )}
      {signOut !== undefined && (
        <Dialog
          open={signOutOpen}
          onClose={() => setSignOutOpen(false)}
          title={copy.signOutTitle}
          closeLabel={t('dialogClose')}
          actions={
            <>
              <Button onClick={() => setSignOutOpen(false)}>{copy.cancel}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const form = document.createElement('form')
                  form.method = 'POST'
                  form.action = signOut
                  document.body.append(form)
                  form.submit()
                  form.remove()
                }}
              >
                {copy.signOut}
              </Button>
            </>
          }
        >
          <p>{copy.signOutDescription}</p>
        </Dialog>
      )}
    </div>
  )
}
interface ConnectViewProps {
  readonly changingServer?: boolean
  readonly t: FrameEnv['t']
  readonly copy: BusinessCopy
  readonly styles: AuthStyles
  readonly origin: string
  readonly pending: OryhWorkspaceSnapshot['pendingConnection']
  readonly busy: BusyAction
  readonly onOriginChange: (origin: string) => void
  readonly onBegin: () => void
  readonly onCancel: () => void
}
function ConnectView({
  changingServer = false,
  styles,
  origin,
  pending,
  busy,
  onOriginChange,
  onBegin,
  onCancel,
  t,
  copy,
}: ConnectViewProps): ReactNode {
  return (
    <section className={styles.intro} aria-labelledby="connect-heading">
      <span className="oryh-caption">{copy.connection}</span>
      <h1 id="connect-heading">{changingServer ? copy.changeServer : copy.connectEnterprise}</h1>
      <p>{changingServer ? copy.changeServerDescription : t('text7')}</p>
      {pending === undefined ? (
        <div className={`surface ${styles.card}`}>
          <div className={styles.connectForm}>
            <Field label={copy.origin} hint={copy.originHelp}>
              <Input
                value={origin}
                list="oryh-server-suggestions"
                placeholder="https://your-oryh.example.com"
                onChange={event => onOriginChange(event.target.value)}
              />
              <datalist id="oryh-server-suggestions">
                <option value="https://oryh.ai" />
                <option value="https://oryh.cn" />
              </datalist>
            </Field>
            <Button
              variant="primary"
              icon={<IconDeviceDesktop size={18} stroke={1.8} />}
              disabled={busy !== undefined || !origin.trim()}
              onClick={onBegin}
            >
              {copy.startConnection}
            </Button>
          </div>
        </div>
      ) : (
        <DeviceAuthorization styles={styles} pending={pending} busy={busy} onCancel={onCancel} copy={copy} />
      )}
    </section>
  )
}
interface DeviceAuthorizationProps {
  readonly copy: BusinessCopy
  readonly styles: AuthStyles
  readonly pending: NonNullable<OryhWorkspaceSnapshot['pendingConnection']>
  readonly busy: BusyAction
  readonly switchingAccount?: boolean
  readonly onCancel: () => void
}
/** Present only the safe device-flow prompt; credentials remain in the local Host. */
function DeviceAuthorization({
  styles,
  pending,
  busy,
  switchingAccount = false,
  onCancel,
  copy,
}: DeviceAuthorizationProps): ReactNode {
  return (
    <div className={`surface ${styles.card}`}>
      <div className={styles.approval}>
        <div className={styles.cardTitle}>
          <h2>{copy.approvalTitle}</h2>
          <p>{copy.approvalDescription}</p>
          {switchingAccount && <span className="oryh-caption">{copy.switchAccountHelp}</span>}
        </div>
        <div>
          <span className="oryh-caption">{copy.userCode}</span>
          <div className={styles.code}>{pending.prompt.userCode}</div>
        </div>
        <div className={styles.inlineStatus}>
          <Spinner size="sm" label={copy.waitingApproval} />
        </div>
        <div className={styles.resultToolbar}>
          <LinkButton variant="primary" href={pending.prompt.verificationUriComplete} target="_blank" rel="noreferrer">
            {copy.openApproval}
          </LinkButton>
          <Button disabled={busy !== undefined} onClick={onCancel}>
            {copy.cancel}
          </Button>
        </div>
      </div>
    </div>
  )
}
function tenantName(connection: ConnectionSummary): string {
  return connection.identity.tenant.name ?? connection.identity.tenant.slug
}
function messageFor(reason: unknown, copy: BusinessCopy): string {
  if (reason instanceof LocalRemoteError && reason.code === 'employee-required') return copy.employeeRequired
  if (reason instanceof LocalRemoteError && reason.code === 'connection-identity-mismatch')
    return copy.connectionIdentityMismatch
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  return copy.genericError
}
