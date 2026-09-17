/**
 * What a page plugin builds on. One bundle answers every `@oryh/dsh-client-frame/client` import,
 * so the React contexts, the Fluent provider and the pane hooks are the same instances in every page.
 */
export * from '@fluentui/react-components'
export { type BusinessRow, businessRows, emptyFilter, filterRows, type ViewFilter } from './business-data.js'
export type { BusinessKey, BusinessText } from './business-locales.js'
export {
  BusinessPage,
  type ListHandle,
  OpenInConsole,
  type PageContext,
  RecordFields,
  useListHandle,
} from './business-page.js'
export {
  type ColumnCatalog,
  columnPreference,
  columnPreferenceScope,
  createColumnPreference,
  useColumnPreference,
} from './column-preferences.js'
export type { BusinessView } from './layout-store.js'
export {
  BackToList,
  ClearConditionsButton,
  EmptyState,
  ErrorNote,
  formatDate,
  formatDateTime,
  formatDisplayValue,
  ListFooter,
  ListLoading,
  NewButton,
  PageHeader,
  RefreshButton,
  RowOpenCell,
  RowOpenHeader,
  StaleNote,
  StatusPill,
} from './list-kit.js'
export { dictionaries, LocaleContext, type OryhKey, type OryhText, useBusinessText, useText } from './locale.js'
export { ClientPages, type PageRegistration } from './pages-registry.js'
export {
  BusinessNavigationContext,
  BusinessSessionContext,
  type PaneFormProposal,
  PaneLocalStore,
  type PaneNavigation,
  PaneValueContext,
  useCommand,
  usePane,
  usePaneAck,
  useServerRefresh,
} from './pane.js'
export type { PaneStreamState } from './pane-stream.js'
/** A pane for component tests; exported so page plugins test against the real local store. */
export { fakePane } from './pane-test.js'
export {
  connectionRequest,
  type FrameRemote,
  LocalRemoteError,
  RemoteContext,
  unwrap,
  useOryhRemote,
} from './remote.js'
export { type StatusTone, statusLabel, statusTone } from './status-words.js'
export { isUserViewPage, type UserViewPage, userViewPage, useUserViews } from './user-views.js'
export {
  booleanPreference,
  filterPreference,
  PreferenceDetails,
  PreferenceScope,
  pagePreference,
  productPreference,
  queryFieldsPreference,
  queryValuesPreference,
  textPreference,
  useViewPreference,
} from './view-preferences.js'
export { type BridgeOwnerProps, type PageOwnerProps, usePages } from './workbench.js'
