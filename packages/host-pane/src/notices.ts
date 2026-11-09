/** What page tools say when there is no pane to act on: a normal state, not a fault. */

/** Said whenever a tool needs the business pane and this session has none. */
export const NO_PAGE =
  '中间栏还没有打开 ORYH 业务页面（本会话没有关联页面）。请告诉用户在左侧菜单打开「ORYH 业务」；不需要页面的查询照常按 skill 在对话里完成。'

/** What `oryh_navigate` answers when no pane is open to carry the navigation out. */
export const NAVIGATION_WITHOUT_PANE =
  '中间栏还没有打开 ORYH 业务页面，无法导航。请告诉用户在左侧菜单打开「ORYH 业务」；不需要页面的查询照常按 skill 在对话里完成。'

/**
 * What a tool is told when it would have moved the pane off a page the person is typing in, without
 * their having asked to see anything else.
 */
export const UNSAVED_KEEPS_PAGE =
  '中间栏当前页面有用户尚未保存的内容，没有切换页面。照常在对话里回答；只有用户明确要求打开或查看别的页面时，才带 show: true 再打开。'

/**
 * What a tool is told when it would have replaced a record or a form the person has open, without their
 * having asked to see anything else.
 */
export const OPEN_KEEPS_PAGE =
  '中间栏正开着用户在看的记录或表单，没有替他换页。在回答里把记录写成链接，用户点了就会在中间栏打开；只有用户明确要求打开或查看时，才带 show: true 再调用。'

/** The page-context entry when no page is synced. */
export const NO_PAGE_CONTEXT =
  '当前没有已同步的业务页面。不要把聊天历史中的页面当作当前页面；需要页面时先读取 oryh_current_page，不需要页面的业务直接按 skill 完成。'
