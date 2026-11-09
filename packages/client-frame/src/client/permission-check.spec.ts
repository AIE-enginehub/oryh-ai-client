import { describe, expect, it } from 'vitest'
import { entranceLost, isFinalFailure, mayEnterAgain, retryDelay } from './permission-check.js'

describe('a failed check of the account', () => {
  it('is final only when it is an answer about the person', () => {
    for (const code of ['connection-identity-mismatch', 'connection-not-found', 'authentication-failed'])
      expect(isFinalFailure({ code, business: true })).toBe(true)
    // A request that did not get through, a credential being renewed: worth asking again.
    for (const code of ['request-failed', 'refresh-failed', 'invalid-response'])
      expect(isFinalFailure({ code, business: true })).toBe(false)
    // The transport's own failure carries a code of its own and is never the Host's answer.
    expect(isFinalFailure({ code: 'connection-identity-mismatch', business: false })).toBe(false)
    expect(isFinalFailure(new Error('socket closed'))).toBe(false)
    expect(isFinalFailure(undefined)).toBe(false)
  })

  it('is asked again soon, then less often, and never less than twice a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryDelay)).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
    expect(retryDelay(0)).toBe(2000)
  })

  it("knows the front door's refusal from every other failure, and enters again once a minute at most", () => {
    // What the control process's front door answers a page whose session it no longer holds.
    expect(entranceLost({ status: 403, text: 'Sign in again.' })).toBe(true)
    // A Host that is starting, a Host answering for itself, a desktop Host with no front door at all.
    expect(entranceLost({ status: 503, text: '' })).toBe(false)
    expect(entranceLost({ status: 403, text: 'Forbidden' })).toBe(false)
    expect(entranceLost({ status: 404, text: 'Not Found' })).toBe(false)
    expect(entranceLost({ status: 200, text: 'Sign in again.' })).toBe(false)

    expect(mayEnterAgain(undefined, 1_000_000)).toBe(true)
    expect(mayEnterAgain(1_000_000 - 5_000, 1_000_000)).toBe(false)
    expect(mayEnterAgain(1_000_000 - 61_000, 1_000_000)).toBe(true)
  })
})
