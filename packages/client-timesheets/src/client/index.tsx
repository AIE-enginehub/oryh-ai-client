/** Timesheets as a page plugin: my timesheets and my approvals, over the `oryhTimesheets` namespace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type BridgeOwnerProps, useCommand } from '@oryh/dsh-client-frame/client'
import { TYPERT_REMOTE } from '@oryh/dsh-timesheets/remote'
import { IconChecks, IconClock } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { createTimesheetsApi, TimesheetsApiContext } from './api.js'
import { TimesheetPanel } from './timesheets.js'

export const inject = ['slots', 'remote', 'locale', 'oryhClientPages']

/** Opening a timesheet from Chat lands on the right list; the list itself acknowledges once it shows it. */
function TimesheetBridge({ navigate }: BridgeOwnerProps): ReactNode {
  useCommand(
    'navigation',
    undefined,
    command => {
      if (command.target !== 'timesheet') return false
      navigate(command.manager ? 'timesheet-approvals' : 'timesheets')
      return false
    },
    [navigate],
  )
  return null
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryhTimesheets'], ctx => {
    const api = createTimesheetsApi(ctx.remote)
    const t = ctx.locale.bind('oryh')
    ctx.effect(() => {
      const mine = ctx.oryhClientPages.register({
        page: 'timesheets',
        order: 30,
        icon: IconClock,
        label: () => t('tsMine'),
      })
      const approvals = ctx.oryhClientPages.register({
        page: 'timesheet-approvals',
        order: 31,
        icon: IconChecks,
        label: () => t('tsApprovals'),
      })
      return () => {
        mine()
        approvals()
      }
    }, 'oryh timesheets menu')
    for (const [key, manager] of [
      ['timesheets', false],
      ['timesheet-approvals', true],
    ] as const)
      ctx.slots.inject('oryh.page', () =>
        ctx.slots.register({ name: 'oryh.page', key }, ({ connection, active, onDirtyChange, onContext }) => (
          <TimesheetsApiContext.Provider value={api}>
            <TimesheetPanel
              connection={connection}
              manager={manager}
              active={active}
              onDirtyChange={onDirtyChange}
              onContext={onContext}
            />
          </TimesheetsApiContext.Provider>
        )),
      )
    ctx.slots.inject('oryh.bridge', () =>
      ctx.slots.register({ name: 'oryh.bridge', id: 'timesheets' }, TimesheetBridge),
    )
  })
}
