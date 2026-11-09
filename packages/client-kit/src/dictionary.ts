/**
 * Every word the workbench and its pages say, by key. The frame plugin registers it with Harness's locale
 * service under `oryh`; nothing else needs the words themselves, only their keys — which is why this is
 * its own entry and not part of the library's index: a page plugin bundles the hooks and not the dictionary.
 */
import { useMemo } from 'react'
import { businessZh } from './business-locales.js'
import { zhCN } from './copy.js'
import { kitWords } from './kit-words.js'
import { timesheetZh } from './timesheet-locale.js'
export const dictionaries = {
  interfaceLanguage: 'zh',
  salesOrders: '销售订单',
  inventoryItems: '库存余额',
  inventoryDetails: '库存流水',
  shipments: 'Shipment · 收发货',
  ...timesheetZh,
  ...businessZh,
  ...kitWords,
  ...zhCN,
  modelSettings: '模型与设置',
  modelSetupRequired: '请检查模型配置',
  modelMissingKey: '当前模型尚未配置 API Key，暂时无法聊天。企业连接不受影响。',
  modelInvalidKey: '模型服务未接受当前 API Key，请检查密钥、服务地址及账号权限。',
  modelUnavailable: '当前选择的模型不可用，请检查模型配置并重新选择。',
  modelSetupPath:
    '左下角账号或「模型与设置」→ Models，配置服务地址、模型和 API Key；保存后在聊天框底部选择模型，再重试。',

  accountSettings: '用户与设置',
  businessNavigation: '业务导航',
  menuWork: '我的工作',
  menuBusiness: '业务管理',
  menuInsights: '分析',
  menuViews: '我的视图',
  menuShared: '同事共享的',
  menuSharedBy: '{label}（{name} 共享）',
  menuConnection: '连接',
  workbench: '工作台',
  sessionsSettings: '会话与设置',
  toggleMenu: '收起或展开菜单',
  businessView: '业务视图',
  assistant: 'AI 助手',
  nativeChat: 'ORYH 智能助手',
  hideChat: '隐藏 Chat',
  showChat: '显示 Chat',
  replyWaiting: 'AI 助手有新回复或在等你确认',
  narrowChat: '收窄 Chat',
  widenChat: '加宽 Chat',
  expandMenu: '展开菜单',
  collapseMenu: '收起菜单',
  resizeMenu: '调整业务菜单高度',
  resizeMenuHint: '拖动调整业务菜单与会话区的高度，双击恢复自动',
  open: 'ORYH 业务',
  close: '返回对话',
  signOut: '登出',
  switchAccount: '切换账号',
  title: 'ORYH 企业工作台',
}
export type OryhKey = keyof typeof dictionaries
export type BusinessCopy = Record<keyof typeof zhCN, string>
/**
 * The connection screen's copy, as one object.
 * @param t - the frame's words.
 */
export function useBusinessCopy(t: (key: OryhKey, params?: Record<string, unknown>) => string): BusinessCopy {
  return useMemo(
    () => Object.fromEntries(Object.keys(zhCN).map(key => [key, t(key as keyof typeof zhCN)])) as BusinessCopy,
    [t, t('interfaceLanguage')],
  )
}

export { english } from './en.js'
