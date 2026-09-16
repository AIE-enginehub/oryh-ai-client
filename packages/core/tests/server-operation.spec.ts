import { expect, it } from 'vitest'
import { canonicalJson, operationDigest } from '../src/index.js'

it('digests equal requests equally, whatever order their keys were built in', () => {
  expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, e: null }] })).toBe('{"a":[{"d":2,"e":null}],"b":1}')
  const a = operationDigest({ method: 'POST', path: '/timesheet-headers', body: { period_start: '2026-09-07', entries: [{ hours: 8, work_date: '2026-09-08' }] } })
  const b = operationDigest({ method: 'POST', path: '/timesheet-headers', body: { entries: [{ work_date: '2026-09-08', hours: 8 }], period_start: '2026-09-07' } })
  expect(a).toBe(b)
  expect(a).toMatch(/^[a-f0-9]{64}$/)
  expect(operationDigest({ method: 'POST', path: '/timesheet-headers', body: { period_start: '2026-09-08' } })).not.toBe(a)
  expect(operationDigest({ method: 'PATCH', path: '/timesheet-headers', body: { period_start: '2026-09-07', entries: [{ hours: 8, work_date: '2026-09-08' }] } })).not.toBe(a)
})
