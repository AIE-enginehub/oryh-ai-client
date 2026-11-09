/**
 * What the frame plugin hands a page plugin, and how a page passes it on to its own components.
 *
 * A page is another plugin with its own bundle, so nothing here is shared by being the same module: the
 * frame's slots carry it. What the frame knows at the moment it draws a page comes as owner props
 * ({@link FrameShare}); what its services hold comes as the slots' own inject ({@link PageInject}), from
 * which the renderer makes the `use…` hooks. Together they are a page's {@link PageFace}: the props its
 * entry was drawn with. A component that needs any of it is given the face as a prop — there is no React
 * context to read it from.
 */
import type { ConnectionSummary } from '@oryh/ai-client-core'
import type { PaneContext, UserViewSummary } from '@oryh/dsh-pane/types'
import type { ChatActions, ChatActivity } from './chat-context.js'
import type { OryhText } from './locale.js'
import type { BusinessView, PaneFace, PaneLocal, PaneLocalState, PaneStreamState } from './pane.js'
import type { FrameRemote } from './remote.js'
import type { UserViews } from './user-views.js'
import type { Preferences } from './view-preferences.js'

/** What a page reports about itself to Chat: the Host's pane context, as the pages fill it in. */
export type PageContext = PaneContext

/** What the frame knows when it draws a page or a bridge, the same for every one of them. */
export interface FrameShare {
  /** The Chat session the pane is bound to; undefined when no session is open. */
  readonly sessionId: string | undefined
  /** Opens a business view, as the menu does. */
  readonly navigate: (page: BusinessView, reveal?: boolean) => void
  readonly chat: ChatActions
  /** What the agent of the pane's session is doing. */
  readonly activity: ChatActivity
  /** The person's menu entries. */
  readonly menu: UserViews
  readonly t: OryhText
  /** The renderer's hook over the frame's kept preferences: the value under a name, once it is opened. */
  readonly usePreference: (name: string) => unknown
}

/** What the workbench hands a page plugin's entry when it renders it into `oryh.page`. */
export interface PageOwnerProps {
  connection: ConnectionSummary
  /** Whether this page is the one on screen; a hidden page keeps its state and reads again when shown. */
  active: boolean
  /** The person's menu entry this page is opened as, when it is one. */
  view?: UserViewSummary
  /** Whether the page holds unsaved work; the frame keeps the connection from changing under it. */
  onDirtyChange: (dirty: boolean) => void
  /** What the page shows, for the Host; only the page on screen is reported. */
  onContext: (value: PageContext) => void
  frame: FrameShare
}
/** What the workbench hands the bridges: the always-mounted pieces a page plugin adds to the pane. */
export interface BridgeOwnerProps {
  connection: ConnectionSummary
  /** Open a view; a bridge passes the command's `reveal`, so the agent brings it forward only when asked to. */
  navigate: (page: BusinessView, reveal?: boolean) => void
  frame: FrameShare
}

/** A source the renderer binds a hook to. */
interface Source<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** What the frame's two slots give every occupant: its Remote, the pane's own state, and the pane's sources. */
export interface PageInject {
  remote: FrameRemote
  local: PaneLocal
  /** The frame's registry of kept preferences: columns, filters, the page a list was on. */
  prefs: Preferences
  hooks: {
    pane: Source<PaneStreamState>
    paneLocal: Source<PaneLocalState>
  }
}

/**
 * What a page's or a bridge's entry is drawn with, as far as its components need it: the owner props the
 * two slots share, and the slots' inject as the renderer bound it. An entry passes its own props.
 */
export interface PageFace extends PaneFace {
  connection: ConnectionSummary
  frame: FrameShare
  remote: FrameRemote
  prefs: Preferences
}
