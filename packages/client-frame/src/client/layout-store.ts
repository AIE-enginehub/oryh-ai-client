import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { type BusinessView, createViewPreference } from '@oryh/ai-client-kit'
import { z } from 'zod'
/** A built-in page, or a menu entry the person made (`view:<id>`). */
export type { BusinessView }
/** Who is signed in, and what the menu may show them: built-in pages they may open, and their own entries. */
export interface FrameIdentity {
  /** The enterprise identity (`columnPreferenceScope`), which the page shown is kept under. */
  scope: string
  company: string
  email: string
  /** Sign out of a deployment that holds this sign-in; absent on the desktop, where nobody signed in here. */
  signOut?: () => void
  /** Hands this single-user client to another ORYH account, where its deployment lets the person. */
  switchAccount?: () => void
  allowedPages?: string[]
  views?: { id: string; label: string; collection?: string; origin?: 'role' | 'shared'; sharedBy?: string }[]
}
export interface FrameState {
  identity?: FrameIdentity | undefined
  /** Global central panel selected through the native sidebar; null keeps the Conversation. */
  panelInfo: { activePanelId: MainPanelId | null }
  page: BusinessView
  /** Whose page `page` is: the identity it was restored for and is kept under, until someone else signs in. */
  pageScope?: string | undefined
  narrowExpanded: boolean
  collapsed: boolean
  focus: 'business' | 'chat'
  /** The business view changed behind Chat on a narrow screen, and the person has not looked yet. */
  unseen: boolean
  /**
   * The same from the other side: the agent answered, or stopped to ask, while Chat was out of sight —
   * behind the business view on a narrow screen, or hidden. Filling a form brings the business view
   * forward, and the reply that came with it used to land where nothing said it had.
   */
  chatUnseen: boolean
  chatWidth: number
  /** Business-menu height in px; 0 keeps it at content height and gives the rest to sessions. */
  menuHeight: number
  chatVisible: boolean
  viewport: number
  rightbarShown: boolean
  rightbarTrack: boolean
  rightbarFullscreen: boolean
}
/** Below this width Chat and the business view share one column and take turns (styles.css). */
export const TURN_TAKING_WIDTH = 850
/** Whether Chat is behind the business view: only where the two take turns. */
const chatBehind = (d: Pick<FrameState, 'viewport' | 'focus'>) =>
  d.viewport <= TURN_TAKING_WIDTH && d.focus === 'business'
// A user view survives reload by id; whether it still exists is the workbench's call, since the
// list lives in a different store. An id-shaped string is all this layer can check.
const pagePreference = z
  .union([
    z.enum([
      'my-open-todos',
      'sales-orders',
      'inventory-items',
      'inventory-item-details',
      'shipments',
      'analytics',
      'settings',
    ]),
    z
      .string()
      .regex(/^view:[0-9a-f-]{36}$/)
      .transform(v => v as `view:${string}`),
  ])
  .catch('my-open-todos')
const layoutPreference = z.object({
  collapsed: z.boolean().catch(true),
  chatWidth: z.number().finite().min(280).max(3000).catch(360),
  menuHeight: z.number().finite().min(0).max(2000).catch(0),
  chatVisible: z.boolean().catch(true),
  focus: z.enum(['business', 'chat']).catch('business'),
})
const layoutDefaults = {
  collapsed: true,
  chatWidth: 360,
  menuHeight: 0,
  chatVisible: true,
  focus: 'business' as const,
}
/** The page a person was on last, kept under their enterprise identity as their other view preferences are. */
function keptPage(scope: string) {
  return createViewPreference(scope, 'frame:page', 'my-open-todos' as z.infer<typeof pagePreference>, pagePreference)
}
/**
 * Persist display choices only; identity, viewport and native overlays stay transient.
 *
 * How the frame is laid out belongs to the browser; which page it shows belongs to the person. Kept per
 * browser, the page greeted the next account signing in here with the last one's: a list it may not
 * open, or an entry from someone else's menu, which shows nothing at all.
 */
export function createFrameStore() {
  const layout = createViewPreference(
    'browser',
    'frame',
    layoutDefaults as z.infer<typeof layoutPreference>,
    layoutPreference,
  )
  // The page store of the one person whose page the frame shows.
  let kept: { scope: string; page: ReturnType<typeof keptPage> } | undefined
  const keptFor = (scope: string) => {
    if (kept?.scope !== scope) kept = { scope, page: keptPage(scope) }
    return kept.page
  }
  const handle = defineStore({
    init: (): FrameState => ({
      page: 'my-open-todos',
      narrowExpanded: false,
      unseen: false,
      chatUnseen: false,
      viewport: 1280,
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
      panelInfo: { activePanelId: null },
      ...layout.getSnapshot(),
    }),
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      // A panel whose plugin unloaded must not stay selected over an empty main slot.
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId))
          d.panelInfo.activePanelId = null
      },
      /**
       * Say who is signed in. Someone other than the person the page belongs to gets their own last page
       * back. The same person keeps where they are: the app withdraws and restates the identity whenever
       * what they may see changes, and a page opened in between must stand.
       */
      setIdentity: (d, identity: FrameIdentity | undefined) => {
        d.identity = identity
        if (identity === undefined || identity.scope === d.pageScope) return
        d.pageScope = identity.scope
        d.page = keptFor(identity.scope).getSnapshot()
      },
      /**
       * Open a business view. The agent opens pages to answer as well as when asked to show one; on a
       * narrow screen, where Chat and the business view take turns, only the second may take the person
       * away from the reply they are reading. The first opens behind Chat and marks the switch instead.
       * @param reveal - bring the business view forward; the menu and anything the person asked for do.
       */
      navigate: (d, page: BusinessView, reveal: boolean = true) => {
        if (!reveal && d.focus === 'chat' && d.page !== page) d.unseen = true
        d.page = page
        if (reveal) {
          d.focus = 'business'
          d.unseen = false
        }
        d.narrowExpanded = false
      },
      toggleSidebar: d => {
        if (d.viewport < 1100) d.narrowExpanded = !d.narrowExpanded
        else d.collapsed = !d.collapsed
      },
      showBusiness: d => {
        d.focus = 'business'
        d.unseen = false
      },
      showChat: d => {
        d.focus = 'chat'
        d.chatVisible = true
        d.chatUnseen = false
      },
      toggleChat: d => {
        d.chatVisible = !d.chatVisible
        if (!d.chatVisible) d.focus = 'business'
        else if (!chatBehind(d)) d.chatUnseen = false
      },
      /** The agent answered or is waiting on the person: mark Chat if they cannot see it. */
      chatReplied: d => {
        if (!d.chatVisible || chatBehind(d)) d.chatUnseen = true
      },
      setChatWidth: (d, width: number) => {
        if (Number.isFinite(width)) d.chatWidth = Math.round(Math.max(280, Math.min(width, 3000)))
      },
      // 0 is meaningful: it hands the menu back to content height instead of pinning a px value.
      setMenuHeight: (d, height: number) => {
        if (Number.isFinite(height)) d.menuHeight = Math.round(Math.max(0, Math.min(height, 2000)))
      },
      measure: (d, width: number) => {
        if (width > 0) {
          if (width < 1100 !== d.viewport < 1100) d.narrowExpanded = false
          d.viewport = width
          // Widened until both are on screen: there is nothing left unseen.
          if (d.chatVisible && !chatBehind(d)) d.chatUnseen = false
        }
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        d.rightbarShown = true
        d.rightbarTrack = track
        d.rightbarFullscreen = fullscreen
      },
      closeRightbar: d => {
        d.rightbarShown = false
        d.rightbarTrack = false
        d.rightbarFullscreen = false
      },
    },
  })
  return {
    ...handle,
    create(scopeKey?: string) {
      const instance = handle.create(scopeKey)
      const unsubscribe = instance.subscribe(() => {
        const { page, pageScope, collapsed, chatWidth, menuHeight, chatVisible, focus } = instance.getSnapshot()
        const next = { collapsed, chatWidth, menuHeight, chatVisible, focus }
        if (JSON.stringify(next) !== JSON.stringify(layout.getSnapshot())) layout.set(next)
        // Nobody's until someone signs in; after that, that person's until someone else does.
        if (pageScope !== undefined && keptFor(pageScope).getSnapshot() !== page) keptFor(pageScope).set(page)
      })
      return {
        ...instance,
        dispose: () => {
          unsubscribe()
        },
      }
    },
  }
}
