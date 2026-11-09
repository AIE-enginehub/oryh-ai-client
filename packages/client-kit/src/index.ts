/**
 * What ORYH's pages are drawn with, how they word things, and how they take part in the workbench.
 *
 * A static library: each client plugin bundles its own copy, so nothing here is shared by being the same
 * module in two plugins. The controls and formatters are stateless. The hooks read what the frame plugin
 * handed the page through its slot — the pane, the session, the Remote, the words — which a page puts in
 * place once with {@link PageFrame}; what has to be one instance for everyone stays in the frame plugin.
 */
export {
  AskAi,
  type ChatActions,
  type ChatActivity,
  errorQuestion,
  useAskChat,
  useChatSession,
} from './ask.js'
export { ErrorNote, RowOpenCell } from './ask-notes.js'
export { type BusinessRow, businessRows, emptyFilter, filterRows, type ViewFilter } from './business-data.js'
export type { BusinessKey, BusinessText } from './business-locales.js'
export { BusinessPage, type ListHandle, OpenInConsole, RecordFields } from './business-page.js'
export { ChatActivityNote, waitingElsewhere } from './chat-context.js'
export {
  type ChatFill,
  ChatFillNote,
  changedPaths,
  type FillChange,
  filledMark,
  isFilled,
  rowMarks,
  useChatFill,
  valueAt,
  withValueAt,
} from './chat-fill.js'
export { applyFields, type ChatFormRegistry, useChatForm, useChatForms } from './chat-form.js'
export {
  type ColumnCatalog,
  columnPreferenceScope,
  createColumnPreference,
  setColumnPreference,
  useColumnPreference,
} from './column-preferences.js'
export { Button, Dialog, Field, Input, LinkButton, Notice, Popover, Select, Spinner } from './controls.js'
export { formatDate, formatDateTime, formatDisplayDate, formatDisplayValue } from './dates.js'
export { displayField, displaySection, displayStatus, displayStatusValue } from './display-language.js'
export { DraftLeaveDialog, useBeforeUnload } from './draft-guard.js'
export { connectionRequest, LocalRemoteError, unwrap } from './envelope.js'
export {
  type BridgeOwnerProps,
  type FrameShare,
  type PageContext,
  type PageFace,
  type PageInject,
  type PageOwnerProps,
} from './frame.js'
export {
  BackToList,
  ClearConditionsButton,
  EmptyState,
  ListFooter,
  ListLoading,
  NewButton,
  PageHeader,
  RefreshButton,
  RowOpenHeader,
  StaleNote,
  StatusPill,
  writtenRowProps,
} from './list-kit.js'
export type { OryhKey, OryhText } from './locale.js'
export {
  type BusinessView,
  nothingBound,
  type PaneFace,
  type PaneFormProposal,
  type PaneLocal,
  type PaneLocalState,
  PaneLocalStore,
  type PaneNavigation,
  type PaneStatus,
  type PaneStreamState,
  type SelectHook,
  useCommand,
  usePageContext,
  usePane,
  useServerRefresh,
  useWrittenRecords,
} from './pane.js'
export {
  type ConnectionRemote,
  type FrameRemote,
  type PaneRemote,
  type PaneStreamHandle,
  type PaneStreamStore,
} from './remote.js'
export {
  conditionText,
  fieldLabel,
  fieldLabelFor,
  isStatusField,
  type StatusTone,
  sectionLabel,
  statusLabel,
  statusTone,
  statusValue,
  statusWords,
} from './status-words.js'
export {
  isUserViewPage,
  noUserViews,
  type UserViewPage,
  type UserViews,
  userViewPage,
  viewGranted,
} from './user-views.js'
export {
  booleanPreference,
  createViewPreference,
  filterPreference,
  PreferenceDetails,
  type PreferenceFace,
  type PreferenceSchema,
  type PreferenceStore,
  type Preferences,
  pagePreference,
  productPreference,
  queryFieldsPreference,
  queryValuesPreference,
  textPreference,
  useViewPreference,
} from './view-preferences.js'
export { useViewSharing } from './view-sharing.js'
