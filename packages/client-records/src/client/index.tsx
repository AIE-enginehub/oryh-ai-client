/**
 * Record lists as a page plugin: sales orders, inventory, movements and shipments, plus the menu
 * entries a person makes over them, all over the `oryhRecords` namespace.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  type PageFace,
  type PageOwnerProps,
  setColumnPreference,
  useColumnPreference,
  useCommand,
} from '@oryh/ai-client-kit'
import type { RecordKind } from '@oryh/ai-client-records'
import type {} from '@oryh/dsh-client-frame/client'
import { TYPERT_REMOTE } from '@oryh/dsh-records/remote'
import { IconArrowsExchange, IconBuildingWarehouse, IconShoppingCart, IconTruckDelivery } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { createRecordsApi, type RecordsApi } from './api.js'
import { collectionCatalog, isRecordKind, recordCatalog, recordPageLabels, recordViewKey } from './catalog.js'
import { CollectionPanel } from './collection.js'
import { english } from './en.js'
import { RecordPanel } from './records.js'
import { type WordKey, type Words, words } from './words.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    oryhRecords: WordKey
  }
}

export const inject = ['slots', 'remote', 'locale', 'oryhClientPages']

const MENU: readonly { kind: RecordKind; order: number; icon: typeof IconBuildingWarehouse }[] = [
  { kind: 'sales-orders', order: 50, icon: IconShoppingCart },
  { kind: 'inventory-items', order: 51, icon: IconBuildingWarehouse },
  { kind: 'inventory-item-details', order: 52, icon: IconArrowsExchange },
  { kind: 'shipments', order: 53, icon: IconTruckDelivery },
]

/** One list, as a built-in page or as a person's menu entry over it, with the person's columns. */
function RecordPage({
  kind,
  api,
  face,
  t,
  view,
  active,
  onContext,
}: PageOwnerProps & { kind: RecordKind; api: RecordsApi; face: PageFace; t: Words }): ReactNode {
  const [columns, setColumns] = useColumnPreference(face, recordViewKey(kind, view?.id), recordCatalog(kind, view))
  return (
    <RecordPanel
      kind={kind}
      active={active}
      {...(view ? { view } : {})}
      columns={columns}
      onColumns={setColumns}
      api={api}
      face={face}
      t={t}
      onContext={onContext}
    />
  )
}

/**
 * A menu entry over a collection this client ships no page for.
 *
 * It renders under the `collection` page rather than one of the four lists, and it is registered as a
 * page WITHOUT a menu entry: the menu shows the person's own entries, never this.
 */
function CollectionPage({
  api,
  face,
  t,
  view,
  active,
  onContext,
}: PageOwnerProps & { api: RecordsApi; face: PageFace; t: Words }): ReactNode {
  const [columns, setColumns] = useColumnPreference(
    face,
    recordViewKey('collection' as never, view?.id),
    collectionCatalog(view ?? {}),
  )
  if (!view) return null
  return (
    <CollectionPanel
      view={view}
      active={active}
      columns={columns}
      onColumns={setColumns}
      api={api}
      face={face}
      t={t}
      onContext={onContext}
    />
  )
}

/** Column changes the agent asks for land in the preference store whether or not the list is open. */
export function RecordBridge({ face }: { face: PageFace }): ReactNode {
  const { local } = face
  useCommand(
    face,
    'navigation',
    undefined,
    command => {
      if (command.target !== 'columns' || !command.columns || !command.page || !isRecordKind(command.page)) return false
      const current = local.getSnapshot().context
      if (current?.key !== `${command.page}:list` || current.view?.id !== command.userViewId) return false
      setColumnPreference(
        face,
        recordViewKey(command.page, command.userViewId),
        recordCatalog(command.page),
        command.columns,
      )
      return true
    },
    [face],
  )
  return null
}

export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('oryhRecords', { zh: words, en: english }), 'oryh records locale')
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryhRecords'], ctx => {
    const api = createRecordsApi(ctx.remote)
    const t = ctx.locale.bind('oryh')
    ctx.effect(() => {
      const entries = MENU.map(({ kind, order, icon }) =>
        ctx.oryhClientPages.register({ page: kind, order, icon, label: () => t(recordPageLabels[kind]) }),
      )
      return () => {
        for (const remove of entries) remove()
      }
    }, 'oryh records menu')
    for (const { kind } of MENU)
      ctx.slots.inject('oryh.page', () =>
        ctx.slots.register({ name: 'oryh.page', key: kind, locale: 'oryhRecords' }, props => (
          <RecordPage kind={kind} api={api} face={props} {...props} t={props.t} />
        )),
      )
    ctx.slots.inject('oryh.page', () =>
      ctx.slots.register({ name: 'oryh.page', key: 'collection', locale: 'oryhRecords' }, props => (
        <CollectionPage api={api} face={props} {...props} t={props.t} />
      )),
    )
    ctx.slots.inject('oryh.bridge', () =>
      ctx.slots.register({ name: 'oryh.bridge', id: 'records' }, props => <RecordBridge face={props} />),
    )
  })
}
