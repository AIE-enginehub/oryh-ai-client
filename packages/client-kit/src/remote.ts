/** What a page may ask of the frame's Remote. The frame builds it; a page only ever holds its callbacks. */
import type { OryhClientRemote, SkillRefreshResult } from '@oryh/ai-client-core/types'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type {
  PaneAskRequest,
  PaneBindRequest,
  PaneBindView,
  PaneCopiedView,
  PaneCopySharedViewRequest,
  PaneOpenRecordRequest,
  PaneOpenRecordView,
  PaneShareViewRequest,
  PaneSync,
  UserViewSummary,
} from '@oryh/dsh-pane/types'
import type { PaneStreamState } from './pane.js'

/** React-free subscription surface, so views never own a transport. */
export interface PaneStreamStore {
  getSnapshot(): PaneStreamState
  subscribe(listener: () => void): () => void
}

/** A store plus the lifecycle its owner drives. */
export interface PaneStreamHandle extends PaneStreamStore {
  /** Begin consuming; repeated calls are inert. */
  start(): void
  /** Stop permanently and wait for the consumer to become quiescent. */
  dispose(): Promise<void>
}

/** The pane's side of the bridge, and what every page needs of the connection. */
export interface PaneRemote {
  /** Bind the session to its enterprise; the pane speaks for it from then on. */
  paneBind(request: PaneBindRequest): Promise<PaneBindView>
  paneUnbind(sessionId: string): Promise<void>
  /** What the pane shows now, and the commands it carried out. */
  paneSync(request: PaneSync): Promise<void>
  /** Follow the agent's commands and the Host's published state for a bound session. */
  openPane(request: PaneBindRequest): PaneStreamHandle
  /** The menu a connection has before any session is open: what the person's role implies. */
  paneMenu(connectionId: ConnectionId): Promise<readonly UserViewSummary[]>
  /** Show the record whose link the person clicked in a Chat answer; not opened means the pane cannot. */
  paneOpenRecord(request: PaneOpenRecordRequest): Promise<PaneOpenRecordView>
  /** Put a question asked from a page (「问 AI」) to the session's agent, as the person's turn. */
  paneAsk(request: PaneAskRequest): Promise<void>
  /** Share one of the person's own menu entries with their colleagues, or stop sharing it. */
  paneShareView(request: PaneShareViewRequest): Promise<void>
  /** Take a copy of what a colleague shared — a menu entry, a custom page; the copy is the person's own. */
  paneCopySharedView(request: PaneCopySharedViewRequest): Promise<PaneCopiedView>
  /** Drop the pre-submit review when the person skips it or the submission settles. */
  reviewClear(sessionId: string, connectionId: string): Promise<void>
}
export interface ConnectionRemote {
  connectionDefaults(): Promise<{
    origin: string
    signOut?: string
    switchAccount?: string
    activeConnectionId?: string
  }>
  skillSync(connectionId: string, force?: boolean): Promise<SkillRefreshResult>
}
/**
 * The frame's Remote: connections and their operations (`oryh`), and the pane bridge (`oryhPane`).
 * Each page plugin mounts its own domain namespace beside these.
 */
export type FrameRemote = ConnectionRemote & PaneRemote & OryhClientRemote
