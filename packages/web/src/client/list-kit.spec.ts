import {readFileSync,readdirSync} from 'node:fs'
import {describe,it,expect,vi} from 'vitest'
import {formatDate,formatDateTime,formatDisplayValue} from './list-kit.js'
import {statusLabel,statusTone} from './status-words.js'
vi.mock('@fluentui/react-components',()=>({}))

/**
 * Pages say shared things through `list-kit.tsx`. Each pattern here is one a page once spelled out by
 * hand, and differently from its neighbours; spelling it out again is how the drift comes back.
 */
const handWritten:[RegExp,string][]=[
 [/className="(empty-state|table-footer|pagination|list-loading|business-page-header)"/,'EmptyState, ListFooter, ListLoading or PageHeader'],
 [/record-status/,'StatusPill'],
 [/<Badge\b/,'StatusPill — status is never a Fluent Badge'],
 [/\bIcon(Refresh|ArrowLeft|ChevronLeft)\b/,'RefreshButton, BackToList or ListFooter'],
 [/>\s*(打开|查看)\s*</,'RowOpenCell — rows open with the trailing ">"'],
 [/←/,'BackToList'],
 [/toLocale(Date|Time)?String\(/,'formatDate, formatDateTime or formatDisplayValue'],
]

describe('shared page vocabulary',()=>{
 const dir=new URL('.',import.meta.url)
 const pages=readdirSync(dir).filter(name=>name.endsWith('.tsx')&&name!=='list-kit.tsx').map(name=>({name,source:readFileSync(new URL(name,dir),'utf8')}))

 it.each(handWritten)('no page writes %s by hand (use %s)',(pattern)=>{
  expect(pages.filter(page=>pattern.test(page.source)).map(page=>page.name)).toEqual([])
 })
})

describe('display values',()=>{
 it('writes a zoneless timestamp as its wall clock and leaves anything else alone',()=>{
  expect(formatDisplayValue('2026-09-01T08:05:00')).toBe('2026-09-01 08:05')
  expect(formatDisplayValue('2026-09-01')).toBe('2026-09-01')
  expect(formatDisplayValue('-1')).toBe('-1')
  expect(formatDisplayValue('PT-HEAD')).toBe('PT-HEAD')
 })

 it('writes a zoned timestamp in local time, to the minute',()=>{
  const moment=new Date('2026-09-01T08:05:30Z'),pad=(n:number)=>String(n).padStart(2,'0')
  expect(formatDisplayValue('2026-09-01T08:05:30Z')).toBe(`${moment.getFullYear()}-${pad(moment.getMonth()+1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`)
  expect(formatDate(moment)).toBe(formatDateTime(moment).slice(0,10))
  expect(formatDate('not a date')).toBe('not a date')
 })
})

describe('status words',()=>{
 it('reads a shipped state the same everywhere and shows a tenant state as the tenant named it',()=>{
  expect(statusLabel('approved')).toBe('已通过')
  expect(statusLabel('awaiting_cfo')).toBe('awaiting_cfo')
  // Object prototype names are not status words.
  expect(statusLabel('constructor')).toBe('constructor')
  expect(statusTone('submitted')).toBe('pending')
  expect(statusTone('awaiting_cfo')).toBe('neutral')
 })
})
