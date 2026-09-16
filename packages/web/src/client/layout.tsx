/** An external root provider: only public slot, store, locale and layout contracts. */
import type { Context } from '@deepseek-ai/cordis'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { HostObservable, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { IconChecklist, IconReceipt, IconFolder, IconSettings, IconLayoutSidebarLeftCollapse, IconMessage, IconFilter } from '@tabler/icons-react'
import { PAGES, type PageId } from '@oryh/ai-client-pages'
import { createFrameStore, type BusinessView, type FrameIdentity } from './layout-store.js'
import { pageLabels } from './page-labels.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'oryh.business': { kind: 'single'; scope: 'root'; owner: { page: BusinessView; navigate: (page:BusinessView)=>void; onIdentity: (identity:FrameIdentity|undefined)=>void } }
  }
}
type FrameProps = PropsRuntime<'root'> & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay' | 'oryh.business'> & PropsStore<ReturnType<typeof createFrameStore>> & PropsLocale<'oryh'>

/**
 * Menu icon for each registered page. The registry owns identity, order and access, and
 * `page-labels.ts` owns what a page is called; only the icon lives here, because it does not
 * belong in a React-free package the Host also reads. Missing entries fail to compile.
 */
const menuIcons: Record<PageId, typeof IconChecklist> = {
  'my-open-todos': IconChecklist,
  'my-expense-claims': IconReceipt,
  timesheets: IconChecklist,
  'timesheet-approvals': IconChecklist,
  'list-projects': IconFolder,
  'sales-orders': IconReceipt,
  'inventory-items': IconFolder,
  'inventory-item-details': IconChecklist,
  shipments: IconReceipt,
  settings: IconSettings,
}
const menu = (id: PageId) => ({ label: pageLabels[id], icon: menuIcons[id] })

/**
 * The official ORYH logo: four connected records around one trusted center, plus the wordmark.
 *
 * Traced from `site/public/brand/oryh-logo.svg` in the ORYH repository rather than redrawn. The
 * two near-black fills become `currentColor` so the mark stays legible on a dark sidebar; only the
 * emerald accent is a fixed brand colour. `compact` drops the wordmark and keeps the square mark,
 * which is what fits an icon rail.
 * @param compact - render the mark alone instead of the full lockup.
 * @returns the inline logo, hidden from assistive tech when a text label sits beside it.
 */
function OryhLogo({ compact }: { compact: boolean }) {
  return <svg className="oryh-logo" viewBox={compact ? '0 0 40 40' : '0 0 73 40'} role="img" aria-label="ORYH" focusable="false">
    <rect x="7" y="4" width="17" height="8" rx="3" fill="currentColor"/>
    <rect x="28" y="9" width="8" height="17" rx="3" fill="currentColor"/>
    <rect x="16" y="28" width="17" height="8" rx="3" fill="#047857"/>
    <rect x="4" y="15" width="8" height="17" rx="3" fill="currentColor"/>
    {!compact && <g transform="translate(42.46 25.28)"><path fill="currentColor" d="M1.54 0.00V-11.88H4.18V-8.98L3.89 -9.35Q4.12 -9.97 4.51 -10.47Q4.89 -10.98 5.46 -11.31Q5.88 -11.57 6.39 -11.72Q6.90 -11.87 7.44 -11.91Q7.97 -11.95 8.51 -11.88V-9.09Q8.02 -9.24 7.36 -9.19Q6.71 -9.14 6.18 -8.89Q5.65 -8.65 5.29 -8.24Q4.93 -7.84 4.74 -7.30Q4.55 -6.75 4.55 -6.07V0.00ZM10.03 5.28 12.32 -1.01 12.36 0.84 7.19 -11.88H10.30L13.77 -2.88H13.07L16.52 -11.88H19.51L12.80 5.28ZM27.50 0.00V-5.61Q27.50 -6.02 27.46 -6.65Q27.41 -7.28 27.18 -7.92Q26.95 -8.56 26.43 -8.99Q25.90 -9.42 24.95 -9.42Q24.56 -9.42 24.12 -9.29Q23.68 -9.17 23.30 -8.83Q22.91 -8.48 22.67 -7.81Q22.42 -7.14 22.42 -6.03L20.70 -6.84Q20.70 -8.25 21.27 -9.48Q21.85 -10.71 23.00 -11.47Q24.14 -12.23 25.89 -12.23Q27.29 -12.23 28.17 -11.76Q29.05 -11.29 29.54 -10.56Q30.03 -9.83 30.24 -9.05Q30.45 -8.26 30.49 -7.61Q30.54 -6.96 30.54 -6.67V0.00ZM19.38 0.00V-15.84H22.04V-7.70H22.42V0.00Z"/></g>}
  </svg>
}

/** Provide exactly one root, and retract service, panel source and child declarations together. */
export function registerFrame(ctx: Context): void {
  ctx.effect(() => {
    // The layout service, the panel-info source and the root entry share one store instance.
    const handle = createFrameStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    const mainPanels = () => ctx.slots.entries('main').flatMap(entry => entry.options.key === undefined ? [] : [entry.options.key])
    let navigation = new AbortController()
    const layout: ILayout = {
      selectPanel: (panelId: MainPanelId | null) => {
        if (panelId !== null && !mainPanels().includes(panelId)) {
          throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
        }
        navigation.abort()
        instance.actions.selectPanel(panelId)
      },
      beginNavigation: () => { navigation.abort(); navigation = new AbortController(); return navigation.signal },
      toggleSidebar: () => instance.actions.toggleSidebar(),
      openRightbar: (track, fullscreen) => instance.actions.openRightbar(track, fullscreen),
      closeRightbar: () => instance.actions.closeRightbar(),
    }
    // The native sidebar reads this standard hook; ORYH owns it because it replaces ui-layout.
    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: listener => instance.subscribe(listener),
    }
    const removePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo } })
    const removeService = ctx.reflect.provide('layout', layout)
    const removeRoot = ctx.slots.register({
      name: 'root', locale: 'oryh', store,
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        main: { kind: 'keyed', scope: 'root' },
        rightbar: { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'oryh.business': { kind: 'single', scope: 'root' },
      },
    }, Frame)
    const retain = () => { instance.actions.retainMainPanels(mainPanels()) }
    const removePanels = ctx.slots.subscribe('main', retain)
    retain()
    return () => {
      navigation.abort()
      removePanels()
      removeRoot()
      removePanelInfo()
      void removeService()
      instance.dispose?.()
    }
  }, 'oryh root layout')
}

function Frame({ useStore, actions, renderSlot, t }: FrameProps) {
  const state = useStore(s => s)
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => actions.measure(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(measure)
    measure(); observer.observe(element)
    return () => observer.disconnect()
  }, [actions])
  const compact = state.viewport < 1100 ? !state.narrowExpanded : state.collapsed
  const sidebarWidth = compact ? 56 : 208
  const maxChatWidth = Math.max(280,state.viewport-(state.viewport<1100?56:sidebarWidth)-320)
  const chatWidth = Math.min(state.chatWidth,maxChatWidth)
  const drag = useRef<{x:number;width:number;pointer:number}|undefined>(undefined)
  const [dragging,setDragging] = useState(false)
  const menuRef = useRef<HTMLElement>(null)
  const menuDrag = useRef<{y:number;height:number;pointer:number}|undefined>(undefined)
  const [draggingMenu,setDraggingMenu] = useState(false)
  const menuHeight = compact ? 0 : state.menuHeight
  // Leave room for the brand, the session heading and a usable session list, so a drag to the
  // bottom cannot squeeze the sessions out of existence.
  const clampMenu = (height:number) => Math.max(96, Math.min(height, Math.max(96, root.current!.getBoundingClientRect().height - 220)))
  return <div ref={root} className="oryh-frame" data-compact={compact} data-focus={state.focus} data-chat={state.chatVisible} data-resizing={dragging} data-resizing-menu={draggingMenu} style={{'--oryh-chat-width':`${chatWidth}px`} as CSSProperties}>
    <aside className="oryh-navigation" aria-label={t('businessNavigation')}>
      <div className="oryh-brand"><OryhLogo compact={compact}/></div>
      <nav ref={menuRef} className="oryh-menu" aria-label={t('text14')} style={menuHeight > 0 ? { height: `${menuHeight}px` } : undefined}>
        {PAGES.filter(page=>page.id!=='settings'&&state.identity?.allowedPages?.includes(page.id)).map(page => {const {label, icon: Icon} = menu(page.id); return <button key={page.id} title={t(label)} aria-label={t(label)} aria-current={state.page === page.id ? 'page' : undefined} onClick={() => actions.navigate(page.id)}><Icon size={19}/>{!compact && <span>{t(label)}</span>}</button>})}
        {/* The person's own entries. Their names are data, not locale keys: nothing here translates them. */}
        {(state.identity?.views??[]).map(view => {const page=`view:${view.id}` as const; return <button key={page} className="oryh-user-view" title={view.label} aria-label={view.label} aria-current={state.page === page ? 'page' : undefined} onClick={() => actions.navigate(page)}><IconFilter size={19}/>{!compact && <span>{view.label}</span>}</button>})}
        {(() => {const {label, icon: Icon} = menu('settings'); return <button key="settings" title={t(label)} aria-label={t(label)} aria-current={state.page === 'settings' ? 'page' : undefined} onClick={() => actions.navigate('settings')}><Icon size={19}/>{!compact && <span>{t(label)}</span>}</button>})()}
      </nav>
      {!compact && <div className="oryh-menu-resizer" role="separator" aria-label={t('resizeMenu')} aria-orientation="horizontal" aria-controls="oryh-native-sidebar" tabIndex={0} title={t('resizeMenuHint')}
        onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId)
          // An auto-height menu has no stored value yet, so the drag starts from what is rendered.
          menuDrag.current={y:e.clientY,height:menuRef.current?.getBoundingClientRect().height??0,pointer:e.pointerId};setDraggingMenu(true)}}
        onPointerMove={e=>{if(menuDrag.current?.pointer===e.pointerId)actions.setMenuHeight(clampMenu(menuDrag.current.height+e.clientY-menuDrag.current.y))}}
        onPointerUp={e=>{if(menuDrag.current?.pointer===e.pointerId){menuDrag.current=undefined;setDraggingMenu(false);e.currentTarget.releasePointerCapture(e.pointerId)}}}
        onPointerCancel={()=>{menuDrag.current=undefined;setDraggingMenu(false)}} onLostPointerCapture={()=>{menuDrag.current=undefined;setDraggingMenu(false)}}
        onDoubleClick={()=>actions.setMenuHeight(0)}
        // Steps come off the stored height, not the rendered one: reading the DOM each keypress
        // measures a layout that has not caught up yet, so repeats drifted well short of the step.
        onKeyDown={e=>{const current=menuHeight>0?menuHeight:(menuRef.current?.getBoundingClientRect().height??0)
          const heights:Record<string,number>={ArrowUp:current-20,ArrowDown:current+20,Home:120,End:2000}
          if(e.key in heights){e.preventDefault();actions.setMenuHeight(clampMenu(heights[e.key]!))}
          if(e.key==='Escape'){e.preventDefault();actions.setMenuHeight(0)}}}/>}
      <div className="oryh-native-heading">{compact ? 'DS' : t('sessionsSettings')}</div>
      <div id="oryh-native-sidebar" className="oryh-native-sidebar">{renderSlot('sidebar', { collapsed: compact, width: sidebarWidth })}</div>
    </aside>
    <div className="oryh-frame-toolbar">
      <button className="oryh-collapse" title={compact?t('expandMenu'):t('collapseMenu')} aria-label={compact?t('expandMenu'):t('collapseMenu')} aria-expanded={!compact} onClick={actions.toggleSidebar}><IconLayoutSidebarLeftCollapse size={18}/></button>
      <div className="oryh-global-heading"><span className="oryh-global-title">{t('title')}</span>{state.identity&&<div className="oryh-global-identity"><strong title={state.identity.company}>{state.identity.company}</strong><span title={state.identity.email}>{state.identity.email}</span></div>}</div>
      <div className="oryh-mobile-switch"><button aria-pressed={state.focus === 'business'} onClick={actions.showBusiness}>{t('businessView')}</button><button aria-pressed={state.focus === 'chat'} onClick={actions.showChat}>{t('assistant')}</button></div>
      <div className="oryh-chat-controls"><button className="oryh-chat-toggle" aria-pressed={state.chatVisible} onClick={actions.toggleChat}><IconMessage size={17}/>{state.chatVisible ? t('hideChat') : t('showChat')}</button></div>
    </div>
    <section className="oryh-business-seat" aria-label={t('businessView')}>{renderSlot('oryh.business', { page: state.page, navigate: actions.navigate, onIdentity: actions.setIdentity })}</section>
    {state.chatVisible&&<div className="oryh-chat-resizer" role="separator" aria-label="调整 Chat 宽度" aria-orientation="vertical" aria-controls="oryh-chat-panel" aria-valuemin={280} aria-valuemax={maxChatWidth} aria-valuenow={chatWidth} tabIndex={0} title="拖动调整 Chat 宽度，双击恢复默认"
      onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,width:chatWidth,pointer:e.pointerId};setDragging(true)}}
      onPointerMove={e=>{if(drag.current?.pointer===e.pointerId)actions.setChatWidth(Math.min(maxChatWidth,drag.current.width+drag.current.x-e.clientX))}}
      onPointerUp={e=>{if(drag.current?.pointer===e.pointerId){drag.current=undefined;setDragging(false);e.currentTarget.releasePointerCapture(e.pointerId)}}}
      onPointerCancel={()=>{drag.current=undefined;setDragging(false)}} onLostPointerCapture={()=>{drag.current=undefined;setDragging(false)}}
      onDoubleClick={()=>actions.setChatWidth(360)}
      onKeyDown={e=>{const widths:Record<string,number>={ArrowLeft:chatWidth+20,ArrowRight:chatWidth-20,Home:280,End:maxChatWidth};if(e.key in widths){e.preventDefault();actions.setChatWidth(Math.min(maxChatWidth,widths[e.key]!))}}}/>}
    {/* No header of our own: the conversation's own row already carries the tabs and actions, and
        a second bar above it only repeated what the top toolbar says. The section keeps its label
        for assistive tech. */}
    <section id="oryh-chat-panel" className="oryh-chat-seat" aria-label={t('assistant')}>
      <div className="oryh-chat-content">{renderSlot('main', {}, { entryKey: state.panelInfo.activePanelId ?? 'conversation' })}</div>
    </section>
    <div className="oryh-artifact-seat">{renderSlot('rightbar', { width: Math.min(640, state.viewport), viewportWidth: state.viewport, canShow: state.viewport >= 700 })}</div>
    <div className="oryh-shell-overlay" data-shell-overlay>{renderSlot('shell.overlay', {})}</div>
  </div>
}
