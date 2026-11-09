import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { unwrap } from '@oryh/ai-client-kit'
import type { OryhRecordRemote } from '@oryh/ai-client-records'
import type {} from '@oryh/dsh-records/remote'

/** The records namespace (`oryhRecords`), as the lists call it. */
export type RecordsApi = OryhRecordRemote
export function createRecordsApi(remote: ClientRemote): RecordsApi {
  const records = remote.oryhRecords
  return {
    productSearch: q => unwrap(records.productSearch(q)),
    recordList: q => unwrap(records.recordList(q)),
    recordGet: (connectionId, kind, id) => unwrap(records.recordGet({ connectionId, kind, id })),
    recordFilterFields: (connectionId, kind) => unwrap(records.recordFilterFields({ connectionId, kind })),
    collectionList: q => unwrap(records.collectionList(q)),
    collectionGet: q => unwrap(records.collectionGet(q)),
    recordDetail: (connectionId, collection, id) => unwrap(records.recordDetail({ connectionId, collection, id })),
    collectionFilterFields: (connectionId, collection) =>
      unwrap(records.collectionFilterFields({ connectionId, collection })),
    collectionRowFields: () => {
      // The browser never chooses columns: a menu entry carries the ones it was made with.
      throw new Error('collectionRowFields is Host-side only')
    },
    roleViews: () => {
      // The role's menu reaches the page on the pane stream, published by the Host.
      throw new Error('roleViews is Host-side only')
    },
  }
}
