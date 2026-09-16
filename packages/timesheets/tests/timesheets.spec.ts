import { describe, it, expect } from 'vitest'
import { validateTimesheet, type TimesheetFields } from '../src/contracts.js'
import { TimesheetService, type TimesheetConnection, type TimesheetHttp } from '../src/service.js'
import { MemoryTimesheetStore } from '../src/store.js'

const fields: TimesheetFields = {
  period_start: '2026-09-07', period_end: '2026-09-11', source_report_text: '原始工时',
  entries: [{ work_date: '2026-09-08', hours: 7.25, work_type: 'regular', project_id: '', task: '测试任务', notes: '真实记录' }],
}
const connection: TimesheetConnection = {
  origin: 'https://oryh.example',
  identity: { permissions: ['timesheet.submit_own'], user: { id: 'user', employeeId: 'employee' }, tenant: { id: 'tenant' } },
}
const service = (http: TimesheetHttp) =>
  new TimesheetService(new MemoryTimesheetStore(), http, () => connection, async () => connection)

describe('timesheet field rules', () => {
  it('accepts a valid period and preserves fractional hours', () => {
    expect(() => validateTimesheet(fields)).not.toThrow()
    expect(fields.entries[0]!.hours).toBe(7.25)
  })
  it('rejects an impossible date, a day over 24 hours and a line outside the period', () => {
    expect(() => validateTimesheet({ ...fields, period_start: '2026-02-30' })).toThrow()
    expect(() => validateTimesheet({ ...fields, entries: [{ ...fields.entries[0]!, hours: 13 }, { ...fields.entries[0]!, hours: 12 }] })).toThrow()
    expect(() => validateTimesheet({ ...fields, entries: [{ ...fields.entries[0]!, work_date: '2026-09-12' }] })).toThrow()
  })
})

describe('malformed ORYH responses', () => {
  // This helper used to be borrowed from the expense contracts, so a broken timesheet
  // response reported an expense conflict. Extracting the domain corrected it; this asserts
  // the corrected code so the old cross-domain error cannot quietly return.
  it('reports a timesheet conflict, not an expense one', async () => {
    const http: TimesheetHttp = { request: async () => 'not-an-object' }
    await expect(service(http).timesheetList('c')).rejects.toMatchObject({
      message: '工时数据无效。',
      code: 'timesheet-conflict',
    })
  })
  it('rejects a non-array data page', async () => {
    const http: TimesheetHttp = { request: async () => ({ data: 'nope', meta: { pages: 1 } }) }
    await expect(service(http).timesheetList('c')).rejects.toMatchObject({ code: 'timesheet-conflict' })
  })
})

describe('employee binding', () => {
  it('refuses to scope work to an account with no employee link', async () => {
    const unlinked: TimesheetConnection = { ...connection, identity: { ...connection.identity, user: { id: 'user', employeeId: null } } }
    const detached = new TimesheetService(new MemoryTimesheetStore(), { request: async () => ({ data: [], meta: { pages: 1 } }) }, () => unlinked, async () => unlinked)
    await expect(detached.timesheetHistory('c')).rejects.toThrow(/未关联员工/)
  })
})

describe('aggregate update',()=>{
  const draft={...fields,entries:[{...fields.entries[0]!,id:'line'}]}
  function setup(revision:string|undefined='version'){
    const requests:Parameters<TimesheetHttp['request']>[1][]=[]
    const http:TimesheetHttp={request:async(_id,r)=>{requests.push(r)
      if(r.path.endsWith('/detail'))return {data:{revision,header:{...fields,id:'h',employee_id:'employee',status:'draft'},entries:draft.entries,approval_records:[]}}
      if(r.path.startsWith('/object-type-definitions'))return {data:[],meta:{pages:1}}
      if(r.path.includes('validate_only'))return {data:{id:'h'},meta:{validate_only:true,written:false}}
      if(r.path.endsWith('/save'))return {data:{id:'h'}}
      throw Error('Unexpected request '+r.path)
    }}
    return {api:service(http),requests}
  }
  it('previews without a write, then saves the entire reviewed draft with one request',async()=>{
    const {api,requests}=setup()
    const review=await api.timesheetPrepare('c',{kind:'update',headerId:'h',expectedRevision:'version',fields:draft})
    expect(requests.filter(r=>r.method==='POST').map(r=>r.path)).toEqual(['/timesheet-headers/h/save?validate_only=true'])
    expect(review.action.fields?.entries[0]?.id).toBe('line')
    const saved=await api.timesheetConfirm('c',review.id,review.revision,review.token)
    expect(saved.state).toBe('done')
    expect(requests.filter(r=>r.path.endsWith('/save'))).toHaveLength(1)
    expect(requests.at(-1)?.body).toMatchObject({entries:[{...draft.entries[0]!,project_id:null}],expected_revision:'version'})
  })
  it('rejects old servers and stale edits before any write or preflight',async()=>{
    const old=setup('')
    await expect(old.api.timesheetPrepare('c',{kind:'update',headerId:'h',fields:draft})).rejects.toThrow(/尚未支持整单更新/)
    expect(old.requests.some(r=>r.method==='POST')).toBe(false)
    const current=setup()
    await expect(current.api.timesheetPrepare('c',{kind:'update',headerId:'h',expectedRevision:'old',fields:draft})).rejects.toThrow(/其他页面修改/)
    expect(current.requests.some(r=>r.method==='POST')).toBe(false)
  })
})

describe('timesheet options', () => {
  it('reads work types without paging, which that endpoint refuses', async () => {
    const paths: string[] = []
    const http: TimesheetHttp = { request: async (_id, r) => { paths.push(r.path); return { data: r.path.startsWith('/type-options') ? [{ name: 'regular', title: '正常' }] : [], meta: { pages: 1 } } } }
    const options = await service(http).timesheetOptions('c')
    expect(options.workTypes).toEqual([{ name: 'regular', title: '正常' }])
    expect(paths.find(p => p.startsWith('/type-options'))).toBe('/type-options?family=work_type&status=active')
  })
})
