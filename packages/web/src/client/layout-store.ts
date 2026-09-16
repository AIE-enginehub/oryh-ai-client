import {z} from 'zod'
import {createViewPreference} from './view-preferences.js'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { OperationId } from '@oryh/ai-client-core/types'
/** A built-in page, or a menu entry the person made (`view:<id>`). */
export type BusinessView = OperationId | import('@oryh/ai-client-records').RecordKind | 'settings' | 'timesheets' | 'timesheet-approvals' | `view:${string}`
/** Who is signed in, and what the menu may show them: built-in pages they may open, and their own entries. */
export interface FrameIdentity { company: string; email: string; allowedPages?: string[]; views?: { id: string; label: string }[] }
export interface FrameState {
  identity?: FrameIdentity | undefined
  /** Global central panel selected through the native sidebar; null keeps the Conversation. */
  panelInfo: { activePanelId: MainPanelId | null }
  page: BusinessView
  narrowExpanded: boolean
  collapsed: boolean
  focus: 'business' | 'chat'
  chatWidth: number
  /** Business-menu height in px; 0 keeps it at content height and gives the rest to sessions. */
  menuHeight: number
  chatVisible: boolean
  viewport: number
  rightbarShown: boolean
  rightbarTrack: boolean
  rightbarFullscreen: boolean
}
const framePreferenceSchema=z.object({
 // A user view survives reload by id; whether it still exists is the workbench's call, since the
 // list lives in a different store. An id-shaped string is all this layer can check.
 page:z.union([z.enum(['my-open-todos','my-expense-claims','list-projects','sales-orders','inventory-items','inventory-item-details','shipments','settings','timesheets','timesheet-approvals']),z.string().regex(/^view:[0-9a-f-]{36}$/).transform(v=>v as `view:${string}`)]).catch('my-open-todos'),
 collapsed:z.boolean().catch(true), chatWidth:z.number().finite().min(280).max(3000).catch(360),
 menuHeight:z.number().finite().min(0).max(2000).catch(0),
 chatVisible:z.boolean().catch(true), focus:z.enum(['business','chat']).catch('business'),
})
const frameDefaults={page:'my-open-todos' as const,collapsed:true,chatWidth:360,menuHeight:0,chatVisible:true,focus:'business' as const}
/** Persist display choices only; identity, viewport and native overlays stay transient. */
export function createFrameStore() {
  const preferences=createViewPreference('browser','frame',frameDefaults as z.infer<typeof framePreferenceSchema>,framePreferenceSchema)
  const handle=defineStore({
    init: (): FrameState => ({ narrowExpanded: false, viewport: 1280, rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false, panelInfo: { activePanelId: null }, ...preferences.getSnapshot() }),
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => { d.panelInfo.activePanelId = panelId },
      // A panel whose plugin unloaded must not stay selected over an empty main slot.
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) d.panelInfo.activePanelId = null
      },
      setIdentity: (d, identity: FrameIdentity | undefined) => { d.identity = identity },
      navigate: (d, page: BusinessView) => { d.page = page; d.focus = 'business'; d.narrowExpanded = false },
      toggleSidebar: d => { if (d.viewport < 1100) d.narrowExpanded = !d.narrowExpanded; else d.collapsed = !d.collapsed },
      showBusiness: d => { d.focus = 'business' },
      showChat: d => { d.focus = 'chat'; d.chatVisible = true },
      toggleChat: d => { d.chatVisible = !d.chatVisible; if (!d.chatVisible) d.focus = 'business' },
      setChatWidth: (d, width:number) => { if(Number.isFinite(width)) d.chatWidth = Math.round(Math.max(280,Math.min(width,3000))) },
      // 0 is meaningful: it hands the menu back to content height instead of pinning a px value.
      setMenuHeight: (d, height:number) => { if(Number.isFinite(height)) d.menuHeight = Math.round(Math.max(0,Math.min(height,2000))) },
      measure: (d, width: number) => { if (width > 0) { if ((width < 1100) !== (d.viewport < 1100)) d.narrowExpanded = false; d.viewport = width } },
      openRightbar: (d, track: boolean, fullscreen: boolean) => { d.rightbarShown = true; d.rightbarTrack = track; d.rightbarFullscreen = fullscreen },
      closeRightbar: d => { d.rightbarShown = false; d.rightbarTrack = false; d.rightbarFullscreen = false },
    },
  })
  return {...handle,create(scopeKey?:string){
    const instance=handle.create(scopeKey)
    const unsubscribe=instance.subscribe(()=>{
      const {page,collapsed,chatWidth,menuHeight,chatVisible,focus}=instance.getSnapshot()
      const next={page,collapsed,chatWidth,menuHeight,chatVisible,focus}
      if(JSON.stringify(next)!==JSON.stringify(preferences.getSnapshot()))preferences.set(next)
    })
    return {...instance,dispose:()=>{unsubscribe()}}
  }}
}
