import type {OryhRecordRemote} from '@oryh/ai-client-records'
import type {ProjectChatState} from '@oryh/dsh-host/types'
import type {OryhProjectRemote} from '@oryh/ai-client-projects'
import type { ChatPageRequest, ChatHomeRequest } from '@oryh/dsh-host/types'
import type { TimesheetChatState } from '@oryh/dsh-host/types'
import type { ChatSelection, ChatContextView } from '@oryh/dsh-host/types'
import type { TodoDocument } from '@oryh/ai-client-todos'
import { createContext, useContext } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// Values, not types: reachable because the gateway is declared external and answered by the
// loader module table. See docs/14, "跨插件值引用".
import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { CommandBaseline, CommandFrame, CommandUpdate } from '@oryh/dsh-host/types'
import type { CommandState, CommandStreamHandle } from './command-stream.js'
import type {} from '@oryh/dsh-host/remote'
import type { OryhClientRemote } from '@oryh/ai-client-core/types'
import type { OryhExpenseRemote } from '@oryh/ai-client-expenses'
import type { ConnectionId } from '@oryh/ai-client-foundation'
import type { OryhTimesheetRemote } from '@oryh/ai-client-timesheets'

interface BusinessChatRemote { connectionDefaults():Promise<{origin:string}>; projectChatSync(request:ProjectChatState):Promise<void>;projectChatClear(sessionId:string):Promise<void>; chatPageSync(request:ChatPageRequest):Promise<void>; chatHomeClear(sessionId:string):Promise<void>; timesheetChatSync(request:TimesheetChatState):Promise<void>; skillSync(connectionId:string,force?:boolean):Promise<import('@oryh/ai-client-core/types').SkillRefreshResult>; timesheetReviewStart(sessionId:string,headerId:string):Promise<void>; expenseReviewStart(sessionId:string,draftId:string):Promise<void>; reviewClear(sessionId:string):Promise<void>; openCommands(request:ChatHomeRequest):CommandStreamHandle; todoDetail(connectionId: string, todoId: string): Promise<TodoDocument>; chatSelect(request: ChatSelection): Promise<ChatContextView>; chatClear(sessionId: string): Promise<void> }
export type BusinessRemote = BusinessChatRemote & OryhRecordRemote & OryhProjectRemote & OryhClientRemote & OryhExpenseRemote & OryhTimesheetRemote
export const RemoteContext = createContext<BusinessRemote | undefined>(undefined)
export function useOryhRemote(): BusinessRemote {
  const remote = useContext(RemoteContext)
  if (!remote) throw new Error('ORYH Remote is not mounted')
  return remote
}
export class LocalRemoteError extends Error {
  /**
   * @param code - the ORYH business code when `business`, otherwise the Gateway's own code.
   * @param message - failure text safe to show.
   * @param business - whether the Host refused on purpose, as opposed to a transport or protocol
   * failure. A refusal will not change by asking again, so callers must not retry it.
   */
  constructor(readonly code: string, message: string, readonly business = false) { super(message); this.name = 'OryhRemoteError' }
}
async function unwrap<T>(call: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: object } }>): Promise<T> {
  const result = await call
  if (!result.ok) {
    const details = result.error.details
    const business = result.error.code === 'oryh/business'
    const code = business && details && 'code' in details && typeof details.code === 'string' ? details.code : result.error.code
    throw new LocalRemoteError(code, result.error.message, business)
  }
  return result.value
}
const streamName = 'ORYH command stream'

/** Text to publish for a terminal stream failure. */
function failureMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Chat 指令同步已中断。'
}

/**
 * Follow one session's pending commands over the generated stream Remote.
 *
 * Built on Harness's own supervision rather than a hand-rolled loop: `$stream` is a service
 * method, so Connection owns the retry timing and only a `RemoteStreamCarrierError` reopens —
 * every other failure is terminal. `RemoteSnapshotStream` adds the baseline-then-deltas
 * protocol, including the single-baseline-per-generation check, and keeps the previous set
 * published while the carrier retries.
 *
 * Every frame carries the whole set, so a reopen republishes a baseline and no command is
 * replayed or lost.
 * @param remote - client Remote carrying the mounted ORYH namespace.
 * @param request - the session and connection to follow.
 * @returns an unstarted store owned by the caller.
 */
function createCommandStream(remote: ClientRemote, request: ChatHomeRequest): CommandStreamHandle {
  let state: CommandState = { commands: {}, status: 'connecting' }
  const listeners = new Set<() => void>()
  const publish = (next: CommandState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const stream = remote.$stream<CommandFrame>({
    name: streamName,
    open: signal => remote.oryh.commands(request, signal) as AsyncIterable<CommandFrame>,
    // A normal end after a baseline means the Host dropped the binding. Marking it retryable
    // spends one reopen to surface the Host's actual reason rather than inventing one here;
    // that reopen is refused as a business error and becomes terminal with the real message.
    // Ending before any baseline breaks the Host's own contract, so it stays terminal at once.
    ended: accepted => accepted
      ? new RemoteStreamCarrierError(`${streamName} was closed by the Host`)
      : new Error(`${streamName} closed before its opening snapshot`),
    carrierFailed: () => { publish({ ...state, status: 'reconnecting' }) },
  })
  const snapshots = new RemoteSnapshotStream<CommandBaseline, CommandUpdate>(stream, {
    name: streamName,
    isSnapshot: (frame): frame is CommandBaseline => frame.type === 'baseline',
    replace: baseline => { publish({ commands: baseline.commands, status: 'synced' }) },
    update: delta => { publish({ commands: delta.commands, status: 'synced' }) },
    // The pending set is dropped on a terminal failure instead of staying published: a command
    // is an instruction for the page, and acting on a stale one after the stream died is wrong.
    failed: error => { publish({ commands: {}, status: 'rejected', error: failureMessage(error) }) },
  })
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => { snapshots.start() },
    dispose: () => snapshots.dispose(),
  }
}

/** The only browser transport is the generated, authenticated Harness Remote. */
export function createOryhRemote(remote: ClientRemote): BusinessRemote {
  const api = remote.oryh
  const connection = (connectionId: string) => ({ connectionId: connectionId as ConnectionId })
  return {
    productSearch:q=>unwrap(api.productSearch(q)),
    recordList:q=>unwrap(api.recordList(q)),
    recordFilterFields:(connectionId,kind)=>unwrap(api.recordFilterFields({connectionId,kind})),
    projectOptions:id=>unwrap(api.projectOptions(connection(id))),
    projectPrepare:(id,fields)=>unwrap(api.projectPrepare({...connection(id),fields})),
    projectConfirm:(id,key,revision,token)=>unwrap(api.projectConfirm({...connection(id),id:key,revision,token})),
    projectHistory:id=>unwrap(api.projectHistory(connection(id))),
    projectReconcile:(id,key,revision)=>unwrap(api.projectReconcile({...connection(id),id:key,revision})),
    projectChatSync:r=>unwrap(api.projectChatSync(r)),
    projectChatClear:sessionId=>unwrap(api.projectChatClear({sessionId})),
    chatPageSync: request => unwrap(api.chatPageSync(request)),
    chatHomeClear: sessionId => unwrap(api.chatHomeClear({sessionId})),
    timesheetChatSync: request => unwrap(api.timesheetChatSync(request)),
    skillSync: (connectionId, force) => unwrap(api.skillSync({ ...connection(connectionId), ...(force ? { force } : {}) })),
    timesheetReviewStart: (sessionId, headerId) => unwrap(api.timesheetReviewStart({ sessionId, headerId })),
    expenseReviewStart: (sessionId, draftId) => unwrap(api.expenseReviewStart({ sessionId, draftId })),
    reviewClear: sessionId => unwrap(api.reviewClear({ sessionId })),
    openCommands: request => createCommandStream(remote, request),
    todoDetail: (id, todoId) => unwrap(api.todoDetail({ ...connection(id), todoId })),
    chatSelect: request => unwrap(api.chatSelect(request)),
    chatClear: sessionId => unwrap(api.chatClear({ sessionId })),
    connectionDefaults: () => unwrap(api.connectionDefaults()),
    listConnections: () => unwrap(api.listConnections()),
    listOperations: () => unwrap(api.listOperations()),
    beginConnection: (origin, clientName) => unwrap(api.beginConnection({ origin, clientName })),
    pollConnection: authorizationId => unwrap(api.pollConnection({ authorizationId })),
    cancelConnection: authorizationId => unwrap(api.cancelConnection({ authorizationId })),
    verifyConnection: connectionId => unwrap(api.verifyConnection({ connectionId })),
    disconnect: connectionId => unwrap(api.disconnect({ connectionId })),
    execute: (connectionId, operationId) => unwrap(api.execute({ connectionId, operationId })),
    reuse: (connectionId, operationId, resultId) => unwrap(api.reuse({ connectionId, operationId, resultId })),
    saveResult: (connectionId, operationId, resultId, label) => unwrap(api.saveResult({ connectionId, operationId, resultId, label })),
    listSavedOperations: connectionId => unwrap(api.listSavedOperations({ connectionId })),
    refreshSavedOperation: (connectionId, savedOperationId) => unwrap(api.refreshSavedOperation({ connectionId, savedOperationId })),
    timesheetList: id => unwrap(api.timesheetList(connection(id))),
    timesheetQueue: id => unwrap(api.timesheetQueue(connection(id))),
    timesheetOptions: id => unwrap(api.timesheetOptions(connection(id))),
    timesheetDetail: (id, headerId, todoId) => unwrap(api.timesheetDetail({ ...connection(id), headerId, ...(todoId ? { todoId } : {}) })),
    timesheetHistory: id => unwrap(api.timesheetHistory(connection(id))),
    timesheetPrepare: (id, action) => unwrap(api.timesheetPrepare({ ...connection(id), action })),
    timesheetConfirm: (cid, id, revision, token, sessionId) => unwrap(api.timesheetConfirm({ ...connection(cid), id, revision, token, ...(sessionId === undefined ? {} : { sessionId }) })),
    timesheetReconcile: (cid, id, revision) => unwrap(api.timesheetReconcile({ ...connection(cid), id, revision })),
    expenseList: id => unwrap(api.expenseList(connection(id))),
    expenseOptions: id => unwrap(api.expenseOptions(connection(id))),
    expenseSave: (id, input) => unwrap(api.expenseSave({ ...connection(id), ...input })),
    expensePrepare: (cid, id, revision) => unwrap(api.expensePrepare({ ...connection(cid), id, revision })),
    expenseConfirm: (cid, id, revision, token) => unwrap(api.expenseConfirm({ ...connection(cid), id, revision, token })),
    expenseReconcile: (cid, id, revision) => unwrap(api.expenseReconcile({ ...connection(cid), id, revision })),
    expenseUpload: (id, input) => unwrap(api.expenseUpload({ ...connection(id), ...input })),
    expenseDelete: (cid, id, revision) => unwrap(api.expenseArchive({ ...connection(cid), id, revision })),
  }
}
