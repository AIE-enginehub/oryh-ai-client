/**
 * Record lists as a page plugin: sales orders, inventory, movements and shipments, plus the menu
 * entries a person makes over them, all over the `oryhRecords` namespace.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RecordKind } from '@oryh/ai-client-records'
import {
  type BridgeOwnerProps,
  columnPreference,
  columnPreferenceScope,
  type PageOwnerProps,
  useColumnPreference,
  useCommand,
} from '@oryh/dsh-client-frame/client'
import { TYPERT_REMOTE } from '@oryh/dsh-records/remote'
import { IconArrowsExchange, IconBox, IconReceipt, IconTruckDelivery } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { createRecordsApi, RecordsApiContext } from './api.js'
import { isRecordKind, recordCatalog, recordPageLabels } from './catalog.js'
import { RecordPanel } from './records.js'

export const inject = ['slots', 'remote', 'locale', 'oryhClientPages']

const MENU: readonly { kind: RecordKind; order: number; icon: typeof IconBox }[] = [
  { kind: 'sales-orders', order: 50, icon: IconReceipt },
  { kind: 'inventory-items', order: 51, icon: IconBox },
  { kind: 'inventory-item-details', order: 52, icon: IconArrowsExchange },
  { kind: 'shipments', order: 53, icon: IconTruckDelivery },
]

/** One list, as a built-in page or as a person's menu entry over it, with the person's columns. */
function RecordPage({ kind, connection, view, onContext }: PageOwnerProps & { kind: RecordKind }): ReactNode {
  const [columns, setColumns] = useColumnPreference(connection, kind, recordCatalog(kind))
  return (
    <RecordPanel
      kind={kind}
      {...(view ? { view } : {})}
      columns={columns}
      onColumns={setColumns}
      connectionId={connection.id}
      onContext={onContext}
    />
  )
}

/** Column changes the agent asks for land in the preference store whether or not the list is open. */
function RecordBridge({ connection }: BridgeOwnerProps): ReactNode {
  useCommand(
    'navigation',
    undefined,
    command => {
      if (command.target !== 'columns' || !command.columns || !command.page || !isRecordKind(command.page)) return false
      columnPreference(columnPreferenceScope(connection), command.page, recordCatalog(command.page)).set(
        command.columns,
      )
      return true
    },
    [connection],
  )
  return null
}

export async function apply(ctx: Context): Promise<void> {
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
        ctx.slots.register({ name: 'oryh.page', key: kind }, props => (
          <RecordsApiContext.Provider value={api}>
            <RecordPage kind={kind} {...props} />
          </RecordsApiContext.Provider>
        )),
      )
    ctx.slots.inject('oryh.bridge', () => ctx.slots.register({ name: 'oryh.bridge', id: 'records' }, RecordBridge))
  })
}
