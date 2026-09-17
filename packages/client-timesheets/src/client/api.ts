import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { OryhTimesheetRemote } from '@oryh/ai-client-timesheets'
import { connectionRequest, unwrap } from '@oryh/dsh-client-frame/client'
import type {} from '@oryh/dsh-timesheets/remote'
import { createContext, useContext } from 'react'

/** The timesheets namespace (`oryhTimesheets`), as the page calls it. */
export interface TimesheetsApi extends OryhTimesheetRemote {
  /** Start the pre-submit review of a timesheet in the bound Chat session. */
  timesheetReviewStart(sessionId: string, headerId: string): Promise<void>
}
export const TimesheetsApiContext = createContext<TimesheetsApi | undefined>(undefined)
export function useTimesheetsApi(): TimesheetsApi {
  const api = useContext(TimesheetsApiContext)
  if (!api) throw new Error('ORYH timesheets Remote is not mounted')
  return api
}
export function createTimesheetsApi(remote: ClientRemote): TimesheetsApi {
  const timesheets = remote.oryhTimesheets
  const connection = connectionRequest
  return {
    timesheetList: id => unwrap(timesheets.timesheetList(connection(id))),
    timesheetQueue: id => unwrap(timesheets.timesheetQueue(connection(id))),
    timesheetOptions: id => unwrap(timesheets.timesheetOptions(connection(id))),
    timesheetDetail: (id, headerId, todoId) =>
      unwrap(timesheets.timesheetDetail({ ...connection(id), headerId, ...(todoId ? { todoId } : {}) })),
    timesheetHistory: id => unwrap(timesheets.timesheetHistory(connection(id))),
    timesheetPrepare: (id, action) => unwrap(timesheets.timesheetPrepare({ ...connection(id), action })),
    timesheetConfirm: (cid, id, revision, token, sessionId) =>
      unwrap(
        timesheets.timesheetConfirm({
          ...connection(cid),
          id,
          revision,
          token,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      ),
    timesheetReconcile: (cid, id, revision) =>
      unwrap(timesheets.timesheetReconcile({ ...connection(cid), id, revision })),
    timesheetReviewStart: (sessionId, headerId) => unwrap(timesheets.timesheetReviewStart({ sessionId, headerId })),
  }
}
