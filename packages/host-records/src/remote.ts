import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  OryhRecordRemote,
  ProductOptions,
  ProductSearch,
  RecordFilterField,
  RecordPage,
  RecordQuery,
} from '@oryh/ai-client-records'
import { RemoteCalls } from '@oryh/dsh-connection'
import type { RecordFilterFieldsRequest } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhRecords: OryhRecordRemote
    oryhRecordsRemote: RecordsRemote
  }
}

/** Browser-only record list API: server-paged reads with the filters each endpoint declares. */
export class RecordsRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhRecords']
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhRecordsRemote', { namespace: 'oryhRecords' })
    this.calls = new RemoteCalls(ctx, 'oryhRecords')
  }
  @Remote('productSearch') productSearch(r: ProductSearch): Promise<ProductOptions> {
    return this.calls.call(() => this.ctx.oryhRecords.productSearch(r))
  }
  @Remote('recordList') recordList(r: RecordQuery): Promise<RecordPage> {
    return this.calls.call(() => this.ctx.oryhRecords.recordList(r))
  }
  @Remote('recordFilterFields') recordFilterFields(r: RecordFilterFieldsRequest): Promise<RecordFilterField[]> {
    return this.calls.call(() => this.ctx.oryhRecords.recordFilterFields(r.connectionId, r.kind))
  }
}
