import { describe, expect, it } from 'vitest'
import { deploymentTimeZone, readClock, timeZoneOf } from '../src/clock.js'
import { PaneService } from '../src/service.js'
import { connectionId, fakeConnection, fakeContext, fakeController, tempDirectory } from '../src/testing.js'
import { installPaneTools } from '../src/tools.js'
import { UserViewRegistry } from '../src/user-views.js'

describe('reading the clock in a zone', () => {
  it('gives the day, weekday, offset and moment as that zone has them', () => {
    // 23:30 UTC on a Wednesday is already Thursday morning in Shanghai, and still Wednesday in New York.
    const at = new Date('2026-10-07T23:30:05Z')
    expect(readClock('Asia/Shanghai', 'browser', at)).toEqual({
      timeZone: 'Asia/Shanghai',
      source: 'browser',
      today: '2026-10-08',
      weekday: 4,
      offset: '+08:00',
      now: '2026-10-08T07:30:05+08:00',
    })
    expect(readClock('America/New_York', 'browser', at)).toMatchObject({
      today: '2026-10-07',
      weekday: 3,
      offset: '-04:00',
      now: '2026-10-07T19:30:05-04:00',
    })
    expect(readClock('UTC', 'deployment', at)).toMatchObject({ today: '2026-10-07', offset: '+00:00', weekday: 3 })
  })

  it('writes midnight as hour 00 and Sunday as the seventh day', () => {
    expect(readClock('Asia/Shanghai', 'browser', new Date('2026-10-10T16:00:00Z'))).toMatchObject({
      today: '2026-10-11',
      weekday: 7,
      now: '2026-10-11T00:00:00+08:00',
    })
  })

  it('takes a zone only when it is one', () => {
    expect(timeZoneOf('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(timeZoneOf('UTC')).toBe('UTC')
    for (const bad of ['Mars/Olympus', '', '+08:00 or so', 8, undefined, null, 'A'.repeat(65)])
      expect(timeZoneOf(bad)).toBeUndefined()
  })

  it('keeps deployment time where ORYH_TIME_ZONE says, and in the process zone when it says nothing usable', () => {
    const own = new Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(deploymentTimeZone({ ORYH_TIME_ZONE: ' Asia/Tokyo ' })).toBe('Asia/Tokyo')
    expect(deploymentTimeZone({ ORYH_TIME_ZONE: 'nowhere' })).toBe(own)
    expect(deploymentTimeZone({})).toBe(own)
  })
})

describe("a session's clock", () => {
  async function setup() {
    const temp = await tempDirectory()
    const harness = fakeContext()
    const { controller } = fakeController(fakeConnection(), 1)
    const pane = new PaneService(harness.ctx, controller, temp.directory, new UserViewRegistry(harness.ctx))
    installPaneTools(harness.ctx, pane)
    let revision = 0
    const sync = (timeZone?: unknown) =>
      pane.sync({
        sessionId: 's',
        connectionId,
        instance: 'i',
        revision: ++revision,
        page: 'my-open-todos',
        ...(timeZone === undefined ? {} : { timeZone: timeZone as string }),
      })
    const exec = { agent: { id: 's' }, callId: 'call-1', signal: new AbortController().signal }
    return { ...harness, pane, sync, exec, close: temp.close }
  }
  const at = new Date('2026-10-07T23:30:05Z')

  it("is the deployment's until a browser says where it is, then the browser's", async () => {
    const f = await setup()
    try {
      expect(f.pane.clock('s', at).source).toBe('deployment')
      await f.pane.bind({ sessionId: 's', connectionId })
      expect(f.pane.clock('s', at).source).toBe('deployment')
      f.sync('Asia/Shanghai')
      expect(f.pane.clock('s', at)).toMatchObject({ source: 'browser', timeZone: 'Asia/Shanghai', today: '2026-10-08' })
    } finally {
      await f.close()
    }
  })

  it('keeps the last zone a browser gave through a sync that gives none, or one that is not a zone', async () => {
    const f = await setup()
    try {
      await f.pane.bind({ sessionId: 's', connectionId })
      f.sync('America/New_York')
      f.sync()
      expect(f.pane.clock('s', at)).toMatchObject({ timeZone: 'America/New_York', today: '2026-10-07' })
      f.sync('Mars/Olympus')
      expect(f.pane.clock('s', at).timeZone).toBe('America/New_York')
      f.sync('Asia/Shanghai')
      expect(f.pane.clock('s', at).timeZone).toBe('Asia/Shanghai')
    } finally {
      await f.close()
    }
  })

  it('is given, to the second, by the current-page tool, whether or not a page is open', async () => {
    const f = await setup()
    try {
      const none = JSON.parse(await f.tool('oryh_current_page').execute({}, f.exec))
      expect(none.page).toBeNull()
      expect(none.clock).toMatchObject({ source: 'deployment' })
      expect(none.clock.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
      await f.pane.bind({ sessionId: 's', connectionId })
      f.sync('Asia/Shanghai')
      const open = JSON.parse(await f.tool('oryh_current_page').execute({}, f.exec))
      expect(open.page).toBe('my-open-todos')
      expect(open.clock).toMatchObject({ source: 'browser', timeZone: 'Asia/Shanghai', offset: '+08:00' })
      expect(open.clock.now.startsWith(open.clock.today)).toBe(true)
    } finally {
      await f.close()
    }
  })
})
