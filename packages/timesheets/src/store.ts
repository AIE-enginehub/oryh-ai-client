import { EncryptedRevisionStore } from '@oryh/ai-client-store'
import { type TimesheetIntent, timesheetError } from './contracts.js'

export interface TimesheetRecord extends TimesheetIntent {
  scope: string
  digest: string
  payload: Record<string, unknown>
  path: `/${string}`
  method: 'POST' | 'PATCH' | 'DELETE'
}
/** Compare-and-append store; each immutable revision permits at most one writer. */
export interface TimesheetStore {
  list(): Promise<TimesheetRecord[]>
  append(record: TimesheetRecord, previousRevision: number): Promise<void>
}
export class MemoryTimesheetStore implements TimesheetStore {
  private readonly records = new Map<string, TimesheetRecord>()
  async list(): Promise<TimesheetRecord[]> {
    return structuredClone([...this.records.values()])
  }
  async append(record: TimesheetRecord, previousRevision: number): Promise<void> {
    if ((this.records.get(record.id)?.revision ?? 0) !== previousRevision)
      throw timesheetError('记录已改变，请刷新后重试。')
    this.records.set(record.id, structuredClone(record))
  }
}

export class EncryptedTimesheetStore extends EncryptedRevisionStore<TimesheetRecord> implements TimesheetStore {}
