/** What page tools say when there is no pane to act on: a normal state, not a fault. */

/** Said whenever a tool needs the business pane and this session has none. */
export const NO_PAGE =
  '中间栏还没有打开 ORYH 业务页面（本会话没有关联页面）。请告诉用户在左侧菜单打开「ORYH 业务」；不需要页面的查询照常按 skill 在对话里完成。'

/** What `oryh_navigate` answers when no pane is open to carry the navigation out. */
export const NAVIGATION_WITHOUT_PANE =
  '中间栏还没有打开 ORYH 业务页面，无法导航。请告诉用户在左侧菜单打开「ORYH 业务」；不需要页面的查询照常按 skill 在对话里完成。'

/** The page-context entry when no page is synced. */
export const NO_PAGE_CONTEXT =
  '当前没有已同步的业务页面。不要把聊天历史中的页面当作当前页面；需要页面时先读取 oryh_current_page，不需要页面的业务直接按 skill 完成。'
