import { createContext, useContext, useMemo } from 'react'
import { type BusinessText, businessZh } from './business-locales.js'
import { zhCN } from './copy.js'
import { timesheetZh } from './timesheet-locale.js'
export const dictionaries = {
  salesOrders: '销售订单',
  inventoryItems: '库存余额',
  inventoryDetails: '库存流水',
  shipments: 'Shipment · 收发货',
  ...timesheetZh,
  ...businessZh,
  ...zhCN,
  modelSettings: '模型与设置',
  businessNavigation: '业务导航',
  workbench: '工作台',
  sessionsSettings: '会话与设置',
  toggleMenu: '收起或展开菜单',
  businessView: '业务视图',
  assistant: 'AI 助手',
  nativeChat: 'Harness 原生会话',
  hideChat: '隐藏 Chat',
  showChat: '显示 Chat',
  narrowChat: '收窄 Chat',
  widenChat: '加宽 Chat',
  expandMenu: '展开菜单',
  collapseMenu: '收起菜单',
  resizeMenu: '调整业务菜单高度',
  resizeMenuHint: '拖动调整业务菜单与会话区的高度，双击恢复自动',
  open: 'ORYH 业务',
  close: '返回对话',
  signOut: '登出',
  title: 'ORYH 企业工作台',
}
export type OryhKey = keyof typeof dictionaries
export type OryhText = (key: OryhKey, params?: Record<string, unknown>) => string
export type BusinessCopy = Record<keyof typeof zhCN, string>
export const LocaleContext = createContext<OryhText | undefined>(undefined)
export function useText(): OryhText {
  const t = useContext(LocaleContext)
  if (!t) throw new Error('ORYH locale is not mounted')
  return t
}
export function useBusinessText(): BusinessText {
  return useText()
}
export function useBusinessCopy(): BusinessCopy {
  const t = useText()
  return useMemo(
    () => Object.fromEntries(Object.keys(zhCN).map(key => [key, t(key as keyof typeof zhCN)])) as BusinessCopy,
    [t],
  )
}
