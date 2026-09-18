import {
  Button,
  Caption1,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  FluentProvider,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Text,
  Title1,
  Title2,
  webDarkTheme,
  webLightTheme,
} from '@fluentui/react-components'
import type { ConnectionSummary } from '@oryh/ai-client-core'
import { allowedPages } from '@oryh/ai-client-pages'
import { OryhWorkspace, type OryhWorkspaceSnapshot } from '@oryh/ai-client-workspace'
import { IconDeviceDesktop } from '@tabler/icons-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { columnPreferenceScope } from './column-preferences.js'
import type { BusinessView, FrameIdentity } from './layout-store.js'
import { type BusinessCopy, useBusinessCopy, useBusinessText } from './locale.js'
import { LocalRemoteError, useOryhRemote } from './remote.js'
import { useUserViews } from './user-views.js'
import { PreferenceScope } from './view-preferences.js'
import { Workbench } from './workbench.js'

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
type BusyAction = 'load' | 'connect' | 'disconnect' | 'run' | undefined
/** How stale the verified grants may be before returning to the window asks ORYH again. */
const REVERIFY_AFTER_MS = 5 * 60_000
export function App({
  dark,
  page,
  onIdentity,
}: {
  dark: boolean
  page: BusinessView
  onIdentity: (identity: FrameIdentity | undefined) => void
}): ReactNode {
  const t = useBusinessText()
  const copy = useBusinessCopy()
  const styles = authStyles
  const remote = useOryhRemote()
  const workspace = useMemo(() => new OryhWorkspace(remote), [remote])
  const [snapshot, setSnapshot] = useState<OryhWorkspaceSnapshot>(() => workspace.snapshot())
  const actionGeneration = useRef(0)
  const [expenseDirty, setExpenseDirty] = useState(false)
  const [busy, setBusy] = useState<BusyAction>('load')
  const [error, setError] = useState<string | undefined>()
  const [origin, setOrigin] = useState('')
  /** Where this deployment signs people out, when it is the one holding the sign-in (the server). */
  const [signOut, setSignOut] = useState<string>()
  useEffect(() => {
    let live = true
    void remote
      .connectionDefaults()
      .then(defaults => {
        if (!live) return
        setOrigin(current => current || defaults.origin)
        setSignOut(defaults.signOut)
      })
      .catch(() => {
        /* A default is optional; users can still enter their server. */
      })
    return () => {
      live = false
    }
  }, [remote])
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const isDark = dark
  const selectedConnection =
    snapshot.activeConnectionId === undefined
      ? undefined
      : snapshot.connections.find(connection => connection.id === snapshot.activeConnectionId)
  const [verified, setVerified] = useState<ConnectionSummary>()
  const [accessError, setAccessError] = useState(false)
  useEffect(() => {
    let live = true,
      running = false,
      verifiedAt = 0
    setVerified(undefined)
    setAccessError(false)
    const refresh = async () => {
      if (!selectedConnection || running) return
      running = true
      try {
        const next = await remote.verifyConnection(selectedConnection.id)
        verifiedAt = Date.now()
        if (live) {
          setVerified(next)
          setAccessError(false)
        }
      } catch {
        if (live) {
          setVerified(undefined)
          setAccessError(true)
        }
      } finally {
        running = false
      }
    }
    void refresh()
    // No timer: a person who is away needs no fresh grants, and every page read is checked by the
    // Host and by ORYH anyway. Coming back to the window after a while asks once.
    const focus = () => {
      if (Date.now() - verifiedAt >= REVERIFY_AFTER_MS) void refresh()
    }
    window.addEventListener('focus', focus)
    return () => {
      live = false
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
  // Only once verified, and only entries over lists this person may open right now: a permission
  // revoked in ORYH hides the entry exactly as it hides the list underneath.
  const { views: userViews } = useUserViews(permittedConnection)
  const menuViews = userViews.filter(v => permittedPages.includes(v.kind)).map(({ id, label }) => ({ id, label }))
  const menuViewsKey = JSON.stringify(menuViews)
  const company = activeConnection ? tenantName(activeConnection) : undefined
  const email = activeConnection?.identity.user.email
  const askSignOut = useCallback(() => setSignOutOpen(true), [])
  useEffect(() => {
    onIdentity(
      company && email
        ? {
            company,
            email,
            allowedPages: permittedPages,
            views: menuViews,
            ...(signOut === undefined ? {} : { signOut: askSignOut }),
          }
        : undefined,
    )
    return () => onIdentity(undefined)
  }, [company, email, onIdentity, allowedKey, menuViewsKey, signOut, askSignOut])
  const apply = useCallback(
    async (action: () => Promise<void>, nextBusy: BusyAction) => {
      const generation = ++actionGeneration.current
      setBusy(nextBusy)
      setError(undefined)
      try {
        const pending = action()
        setSnapshot(workspace.snapshot())
        await pending
      } catch (reason) {
        if (
          generation === actionGeneration.current &&
          !(reason instanceof Error && 'code' in reason && reason.code === 'stale-request')
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
    void apply(async () => {
      await workspace.load()
    }, 'load')
  }, [apply, workspace])
  useEffect(() => {
    const pending = snapshot.pendingConnection
    if (pending === undefined) return
    let disposed = false
    let timer: number | undefined
    const poll = async () => {
      try {
        await workspace.pollConnection()
        if (!disposed) setSnapshot(workspace.snapshot())
      } catch (reason) {
        if (!disposed) setError(messageFor(reason, copy))
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
  const connectionControls = (
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
                {tenantName(connection)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {/* Connecting and disconnecting are the desktop's, where the person holds the credential. On a
          deployment that signed them in, the one thing to offer is the way out. */}
      {signOut === undefined && (
        <div className="toolbar">
          {activeConnection && !snapshot.pendingConnection && (
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
      {activeConnection && signOut === undefined && (
        <div className="disconnect-section">
          <p>{copy.disconnectDescription}</p>
          <Button disabled={busy !== undefined || expenseDirty} onClick={() => setDisconnectOpen(true)}>
            {copy.disconnect}
          </Button>
        </div>
      )}
    </>
  )
  const notices = (
    <>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
          <Button
            disabled={expenseDirty || busy !== undefined}
            onClick={() => {
              void apply(async () => {
                await workspace.load()
              }, 'load')
            }}
          >
            {t('text4')}
          </Button>
        </MessageBar>
      )}
      {activeConnection && snapshot.pendingConnection && (
        <DeviceAuthorization
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
    <FluentProvider
      theme={isDark ? webDarkTheme : webLightTheme}
      className="client-root"
      data-theme={isDark ? 'dark' : 'light'}
    >
      {activeConnection ? (
        !permittedConnection && page !== 'settings' ? (
          <main className="business-content">
            <p role="status">{accessError ? '无法核验当前账号权限，请刷新页面重试。' : '正在核验当前账号权限…'}</p>
          </main>
        ) : (
          <PreferenceScope.Provider value={columnPreferenceScope(activeConnection)}>
            <Workbench
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
          </PreferenceScope.Provider>
        )
      ) : (
        <main className="connection-screen">
          <div className="connection-brand">
            ORYH <span>{t('text5')}</span>
          </div>
          {notices}
          {busy === 'load' ? (
            <Spinner label={t('text6')} />
          ) : (
            <ConnectView
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
          )}
        </main>
      )}
      {signOut !== undefined && (
        <Dialog
          open={signOutOpen}
          onOpenChange={(_event, data) => {
            if (!data.open) setSignOutOpen(false)
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{copy.signOutTitle}</DialogTitle>
              <DialogContent>{copy.signOutDescription}</DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setSignOutOpen(false)}>
                  {copy.cancel}
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => {
                    window.location.assign(signOut)
                  }}
                >
                  {copy.signOut}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
      <DisconnectDialog
        busy={busy}
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onDisconnect={() => {
          void apply(async () => {
            await workspace.disconnect()
            setDisconnectOpen(false)
          }, 'disconnect')
        }}
      />
    </FluentProvider>
  )
}
interface ConnectViewProps {
  readonly styles: AuthStyles
  readonly origin: string
  readonly pending: OryhWorkspaceSnapshot['pendingConnection']
  readonly busy: BusyAction
  readonly onOriginChange: (origin: string) => void
  readonly onBegin: () => void
  readonly onCancel: () => void
}
function ConnectView({
  styles,
  origin,
  pending,
  busy,
  onOriginChange,
  onBegin,
  onCancel,
}: ConnectViewProps): ReactNode {
  const t = useBusinessText()
  const copy = useBusinessCopy()
  return (
    <section className={styles.intro} aria-labelledby="connect-heading">
      <Caption1>{copy.connection}</Caption1>
      <Title1 id="connect-heading">{copy.connectEnterprise}</Title1>
      <Text>{t('text7')}</Text>
      {pending === undefined ? (
        <Card className={styles.card}>
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
              appearance="primary"
              size="large"
              icon={<IconDeviceDesktop size={18} stroke={1.8} />}
              disabled={busy !== undefined || !origin.trim()}
              onClick={onBegin}
            >
              {copy.startConnection}
            </Button>
          </div>
        </Card>
      ) : (
        <DeviceAuthorization styles={styles} pending={pending} busy={busy} onCancel={onCancel} />
      )}
    </section>
  )
}
interface DeviceAuthorizationProps {
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
}: DeviceAuthorizationProps): ReactNode {
  const t = useBusinessText()
  const copy = useBusinessCopy()
  return (
    <Card className={styles.card}>
      <div className={styles.approval}>
        <div className={styles.cardTitle}>
          <Title2>{copy.approvalTitle}</Title2>
          <Text>{copy.approvalDescription}</Text>
          {switchingAccount && <Caption1>{copy.switchAccountHelp}</Caption1>}
        </div>
        <div>
          <Caption1>{copy.userCode}</Caption1>
          <div className={styles.code}>{pending.prompt.userCode}</div>
        </div>
        <div className={styles.inlineStatus}>
          <Spinner size="tiny" />
          <Text>{copy.waitingApproval}</Text>
        </div>
        <div className={styles.resultToolbar}>
          <Button
            appearance="primary"
            as="a"
            href={pending.prompt.verificationUriComplete}
            target="_blank"
            rel="noreferrer"
          >
            {copy.openApproval}
          </Button>
          <Button appearance="secondary" disabled={busy !== undefined} onClick={onCancel}>
            {copy.cancel}
          </Button>
        </div>
      </div>
    </Card>
  )
}
interface DisconnectDialogProps {
  readonly busy: BusyAction
  readonly open: boolean
  readonly onClose: () => void
  readonly onDisconnect: () => void
}
/** Confirm removal of one local credential bundle without ending the browser's ORYH session. */
function DisconnectDialog({ busy, open, onClose, onDisconnect }: DisconnectDialogProps): ReactNode {
  const t = useBusinessText()
  const copy = useBusinessCopy()
  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => {
        if (!data.open) onClose()
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{copy.disconnectTitle}</DialogTitle>
          <DialogContent>{copy.disconnectDescription}</DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy !== undefined} onClick={onClose}>
              {copy.cancel}
            </Button>
            <Button appearance="primary" disabled={busy !== undefined} onClick={onDisconnect}>
              {copy.disconnect}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
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
