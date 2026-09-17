import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { OryhRecordRemote } from '@oryh/ai-client-records'
import { unwrap } from '@oryh/dsh-client-frame/client'
import type {} from '@oryh/dsh-records/remote'
import { createContext, useContext } from 'react'

/** The records namespace (`oryhRecords`), as the lists call it. */
export type RecordsApi = OryhRecordRemote
export const RecordsApiContext = createContext<RecordsApi | undefined>(undefined)
export function useRecordsApi(): RecordsApi {
  const api = useContext(RecordsApiContext)
  if (!api) throw new Error('ORYH records Remote is not mounted')
  return api
}
export function createRecordsApi(remote: ClientRemote): RecordsApi {
  const records = remote.oryhRecords
  return {
    productSearch: q => unwrap(records.productSearch(q)),
    recordList: q => unwrap(records.recordList(q)),
    recordFilterFields: (connectionId, kind) => unwrap(records.recordFilterFields({ connectionId, kind })),
  }
}
