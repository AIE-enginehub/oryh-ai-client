/** An external root provider: only public slot, store, locale and layout contracts. */

import type { Context } from '@deepseek-ai/cordis'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {
  HostObservable,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
  PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatActivity, SelectHook } from '@oryh/ai-client-kit'
import { IconLayoutSidebarLeftCollapse, IconMessage } from '@tabler/icons-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type BusinessView, createFrameStore, type FrameIdentity } from './layout-store.js'
import { OryhLogo } from './logo.js'
import { BusinessMenu } from './navigation.js'
import type { ClientPages, PagesSnapshot } from './pages-registry.js'
import { businessSessionOf } from './pane.js'
import { registerSettingsEntry } from './settings-entry.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'oryh.business': {
      kind: 'single'
      scope: 'root'
      owner: {
        page: BusinessView
        navigate: (page: BusinessView) => void
        onIdentity: (identity: FrameIdentity | undefined) => void
        /** Bring Chat forward, for a page that has just asked the agent something. */
        showChat: () => void
      }
    }
  }
}
type FrameProps = PropsRuntime<'root'> &
  PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay' | 'oryh.business'> &
  PropsStore<ReturnType<typeof createFrameStore>> &
  PropsLocale<'oryh'> & { useMenuPages: SelectHook<PagesSnapshot> }

/**
 * Provide exactly one root, and retract service, panel source and child declarations together.
 * @param ctx - the plugin's context.
 * @param pages - the pages the page plugins registered; the menu is drawn from it.
 */
export function registerFrame(ctx: Context, pages: ClientPages): void {
  ctx.effect(() => {
    // The layout service, the panel-info source and the root entry share one store instance.
    const handle = createFrameStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    const mainPanels = () =>
      ctx.slots.entries('main').flatMap(entry => (entry.options.key === undefined ? [] : [entry.options.key]))
    let navigation = new AbortController()
    // The native sidebar reads this standard hook; ORYH owns it because it replaces ui-layout. Since DSH
    // 0.1.7-rc.2 the layout service carries the same source.
    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: listener => instance.subscribe(listener),
    }
    const layout: ILayout = {
      panelInfo,
      selectPanel: (panelId: MainPanelId | null) => {
        if (panelId !== null && !mainPanels().includes(panelId)) {
          throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
        }
        navigation.abort()
        instance.actions.selectPanel(panelId)
      },
      beginNavigation: () => {
        navigation.abort()
        navigation = new AbortController()
        return navigation.signal
      },
      toggleSidebar: () => instance.actions.toggleSidebar(),
      openRightbar: (track, fullscreen) => instance.actions.openRightbar(track, fullscreen),
      closeRightbar: () => instance.actions.closeRightbar(),
    }
    const removeSettings = registerSettingsEntry(
      ctx,
      {
        getSnapshot: () => instance.getSnapshot().identity,
        subscribe: listener => instance.subscribe(listener),
      },
      instance.actions.navigate,
    )
    const removePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo } })
    const removeService = ctx.reflect.provide('layout', layout)
    const removeRoot = ctx.slots.register(
      {
        name: 'root',
        locale: 'oryh',
        store,
        children: {
          sidebar: { kind: 'single', scope: 'root' },
          main: { kind: 'keyed', scope: 'root' },
          rightbar: { kind: 'single', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
          'oryh.business': { kind: 'single', scope: 'root' },
        },
        // The pages the page plugins registered, as a source: the renderer makes the hook the menu reads.
        inject: () => ({ hooks: { menuPages: pages } }),
      },
      Frame,
    )
    const retain = () => {
      instance.actions.retainMainPanels(mainPanels())
    }
    const removePanels = ctx.slots.subscribe('main', retain)
    retain()
    return () => {
      navigation.abort()
      removeSettings()
      removePanels()
      removeRoot()
      removePanelInfo()
      void removeService()
      instance.dispose?.()
    }
  }, 'oryh root layout')
}

/**
 * Whether what the agent just did deserves a mark on a Chat the person cannot see: a turn that ended
 * with its reply, or one that stopped to ask them something. Nothing "arrives" from switching sessions,
 * and nothing from the status a session is first seen in.
 * @param before - the session and activity last seen, if any.
 * @param now - the session and activity seen now.
 */
export function chatWantsAttention(
  before: { session: string | undefined; activity: ChatActivity } | undefined,
  now: { session: string | undefined; activity: ChatActivity },
): boolean {
  if (before === undefined || before.session !== now.session || before.activity === now.activity) return false
  return now.activity === 'waiting' || (before.activity === 'running' && now.activity === 'idle')
}

function Frame({ useStore, actions, renderSlot, t, useMenuPages, useSessions, useSessionStatus }: FrameProps) {
  const state = useStore(s => s)
  // The session the business pane is bound to is the one whose replies the person is waiting for.
  const chatSession = useSessions(businessSessionOf)
  const chatActivity = useSessionStatus((statuses): ChatActivity => {
    const status = [...statuses].find(([id]) => String(id) === chatSession)?.[1]
    if (status === undefined) return 'none'
    return status.pendingInteraction !== undefined ? 'waiting' : status.running ? 'running' : 'idle'
  })
  const lastChat = useRef<{ session: string | undefined; activity: ChatActivity }>(undefined)
  useEffect(() => {
    const now = { session: chatSession, activity: chatActivity }
    if (chatWantsAttention(lastChat.current, now)) actions.chatReplied()
    lastChat.current = now
  }, [chatSession, chatActivity, actions])
  const menu = useMenuPages(snapshot => snapshot.pages)
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => actions.measure(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(element)
    return () => observer.disconnect()
  }, [actions])
  const compact = state.viewport < 1100 ? !state.narrowExpanded : state.collapsed
  const sidebarWidth = compact ? 56 : 208
  const maxChatWidth = Math.max(280, state.viewport - (state.viewport < 1100 ? 56 : sidebarWidth) - 320)
  const chatWidth = Math.min(state.chatWidth, maxChatWidth)
  const drag = useRef<{ x: number; width: number; pointer: number } | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const menuRef = useRef<HTMLElement>(null)
  const menuDrag = useRef<{ y: number; height: number; pointer: number } | undefined>(undefined)
  const [draggingMenu, setDraggingMenu] = useState(false)
  const menuHeight = compact ? 0 : state.menuHeight
  // Leave room for the brand, the session heading and a usable session list, so a drag to the
  // bottom cannot squeeze the sessions out of existence.
  const clampMenu = (height: number) =>
    Math.max(96, Math.min(height, Math.max(96, root.current!.getBoundingClientRect().height - 220)))
  return (
    <div
      ref={root}
      className="oryh-frame"
      data-compact={compact}
      data-focus={state.focus}
      data-chat={state.chatVisible}
      data-resizing={dragging}
      data-resizing-menu={draggingMenu}
      style={{ '--oryh-chat-width': `${chatWidth}px` } as CSSProperties}
    >
      <aside className="oryh-navigation" aria-label={t('businessNavigation')}>
        <div className="oryh-brand" data-window-drag>
          <OryhLogo compact={compact} />
        </div>
        <nav
          ref={menuRef}
          className="oryh-menu"
          aria-label={t('text14')}
          style={menuHeight > 0 ? { height: `${menuHeight}px` } : undefined}
        >
          <BusinessMenu
            pages={menu}
            identity={state.identity}
            current={state.page}
            compact={compact}
            navigate={actions.navigate}
            t={t}
          />
        </nav>
        {!compact && (
          <div
            className="oryh-menu-resizer"
            role="separator"
            aria-label={t('resizeMenu')}
            aria-orientation="horizontal"
            aria-controls="oryh-native-sidebar"
            tabIndex={0}
            title={t('resizeMenuHint')}
            onPointerDown={e => {
              if (e.button !== 0) return
              e.preventDefault()
              e.currentTarget.focus()
              e.currentTarget.setPointerCapture(e.pointerId)
              // An auto-height menu has no stored value yet, so the drag starts from what is rendered.
              menuDrag.current = {
                y: e.clientY,
                height: menuRef.current?.getBoundingClientRect().height ?? 0,
                pointer: e.pointerId,
              }
              setDraggingMenu(true)
            }}
            onPointerMove={e => {
              if (menuDrag.current?.pointer === e.pointerId)
                actions.setMenuHeight(clampMenu(menuDrag.current.height + e.clientY - menuDrag.current.y))
            }}
            onPointerUp={e => {
              if (menuDrag.current?.pointer === e.pointerId) {
                menuDrag.current = undefined
                setDraggingMenu(false)
                e.currentTarget.releasePointerCapture(e.pointerId)
              }
            }}
            onPointerCancel={() => {
              menuDrag.current = undefined
              setDraggingMenu(false)
            }}
            onLostPointerCapture={() => {
              menuDrag.current = undefined
              setDraggingMenu(false)
            }}
            onDoubleClick={() => actions.setMenuHeight(0)}
            // Steps come off the stored height, not the rendered one: reading the DOM each keypress
            // measures a layout that has not caught up yet, so repeats drifted well short of the step.
            onKeyDown={e => {
              const current = menuHeight > 0 ? menuHeight : (menuRef.current?.getBoundingClientRect().height ?? 0)
              const heights: Record<string, number> = {
                ArrowUp: current - 20,
                ArrowDown: current + 20,
                Home: 120,
                End: 2000,
              }
              if (e.key in heights) {
                e.preventDefault()
                actions.setMenuHeight(clampMenu(heights[e.key]!))
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                actions.setMenuHeight(0)
              }
            }}
          />
        )}
        <div className="oryh-native-heading">{compact ? 'AI' : t('sessionsSettings')}</div>
        <div id="oryh-native-sidebar" className="oryh-native-sidebar">
          {renderSlot('sidebar', { collapsed: compact, width: sidebarWidth })}
        </div>
      </aside>
      <div className="oryh-frame-toolbar" data-window-drag>
        <button
          className="oryh-collapse"
          title={compact ? t('expandMenu') : t('collapseMenu')}
          aria-label={compact ? t('expandMenu') : t('collapseMenu')}
          aria-expanded={!compact}
          onClick={actions.toggleSidebar}
        >
          <IconLayoutSidebarLeftCollapse size={18} />
        </button>
        <div className="oryh-global-heading">
          <span className="oryh-global-title">{t('title')}</span>
          {state.identity && (
            <div className="oryh-global-identity">
              <strong title={state.identity.company}>{state.identity.company}</strong>
            </div>
          )}
        </div>
        <div className="oryh-mobile-switch">
          <button
            aria-pressed={state.focus === 'business'}
            data-unseen={state.unseen || undefined}
            onClick={actions.showBusiness}
          >
            {t('businessView')}
          </button>
          <button
            aria-pressed={state.focus === 'chat'}
            data-unseen={state.chatUnseen || undefined}
            title={state.chatUnseen ? t('replyWaiting') : undefined}
            onClick={actions.showChat}
          >
            {t('assistant')}
          </button>
        </div>
        <div className="oryh-chat-controls">
          <button
            className="oryh-chat-toggle"
            aria-pressed={state.chatVisible}
            data-unseen={(!state.chatVisible && state.chatUnseen) || undefined}
            title={!state.chatVisible && state.chatUnseen ? t('replyWaiting') : undefined}
            onClick={actions.toggleChat}
          >
            <IconMessage size={17} />
            {state.chatVisible ? t('hideChat') : t('showChat')}
          </button>
        </div>
      </div>
      <section className="oryh-business-seat" aria-label={t('businessView')}>
        {renderSlot('oryh.business', {
          page: state.page,
          navigate: actions.navigate,
          onIdentity: actions.setIdentity,
          showChat: actions.showChat,
        })}
      </section>
      {state.chatVisible && (
        <div
          className="oryh-chat-resizer"
          role="separator"
          aria-label={t('chatResize')}
          aria-orientation="vertical"
          aria-controls="oryh-chat-panel"
          aria-valuemin={280}
          aria-valuemax={maxChatWidth}
          aria-valuenow={chatWidth}
          tabIndex={0}
          title={t('chatResizeHint')}
          onPointerDown={e => {
            if (e.button !== 0) return
            e.preventDefault()
            e.currentTarget.focus()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, width: chatWidth, pointer: e.pointerId }
            setDragging(true)
          }}
          onPointerMove={e => {
            if (drag.current?.pointer === e.pointerId)
              actions.setChatWidth(Math.min(maxChatWidth, drag.current.width + drag.current.x - e.clientX))
          }}
          onPointerUp={e => {
            if (drag.current?.pointer === e.pointerId) {
              drag.current = undefined
              setDragging(false)
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          }}
          onPointerCancel={() => {
            drag.current = undefined
            setDragging(false)
          }}
          onLostPointerCapture={() => {
            drag.current = undefined
            setDragging(false)
          }}
          onDoubleClick={() => actions.setChatWidth(360)}
          onKeyDown={e => {
            const widths: Record<string, number> = {
              ArrowLeft: chatWidth + 20,
              ArrowRight: chatWidth - 20,
              Home: 280,
              End: maxChatWidth,
            }
            if (e.key in widths) {
              e.preventDefault()
              actions.setChatWidth(Math.min(maxChatWidth, widths[e.key]!))
            }
          }}
        />
      )}
      {/* No header of our own: the conversation's own row already carries the tabs and actions, and
        a second bar above it only repeated what the top toolbar says. The section keeps its label
        for assistive tech. */}
      <section id="oryh-chat-panel" className="oryh-chat-seat" aria-label={t('assistant')}>
        <div className="oryh-chat-content">
          {renderSlot('main', {}, { entryKey: state.panelInfo.activePanelId ?? 'conversation' })}
        </div>
      </section>
      <div className="oryh-artifact-seat">
        {renderSlot('rightbar', {
          width: Math.min(640, state.viewport),
          viewportWidth: state.viewport,
          canShow: state.viewport >= 700,
        })}
      </div>
      <div className="oryh-shell-overlay" data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
