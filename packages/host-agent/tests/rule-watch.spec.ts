import { describe, expect, it, vi } from 'vitest'
import { RuleWatch, ruleDigest, ruleScope } from '../src/rule-watch.js'

const id = '11111111-2222-4333-8444-555555555555'
const rule = (version: number, body: string) =>
  JSON.stringify({ data: [{ id, version, status: 'published', body }], meta: { request_id: Math.random() } })
const dataRule = {
  method: 'GET',
  path: '/business-rules?kind=data_rule&object_type=sales_order&in_force_on=2026-10-13',
}

describe('which rules a read was for', () => {
  it('is the scope of its query, whichever tool carried it and however much it asked for', () => {
    expect(ruleScope(dataRule)).toEqual({
      key: 'kind=data_rule&object_type=sales_order',
      label: 'kind=data_rule，object_type=sales_order',
    })
    // The same rules read another way, another day, a page at a time: still those rules.
    expect(
      ruleScope({
        collection: 'business-rules',
        filters: { object_type: 'sales_order', kind: 'data_rule', status: 'published', size: 100 },
      })?.key,
    ).toBe('kind=data_rule&object_type=sales_order')
    expect(ruleScope({ path: '/api/v1/business-rules?object_type=sales_order&kind=data_rule&page=2' })?.key).toBe(
      'kind=data_rule&object_type=sales_order',
    )
    // One rule by its id, and the whole table.
    expect(ruleScope({ path: `/business-rules/${id}` })?.key).toBe(`id=${id}`)
    expect(ruleScope({ path: '/business-rules' })?.key).toBe('*')
  })

  it('is nothing for a read of anything else', () => {
    expect(ruleScope({ path: '/sales-orders?status=draft' })).toBeUndefined()
    expect(ruleScope({ collection: 'business-rule-drafts' })).toBeUndefined()
    // A document that mentions the rules is not the rules.
    expect(ruleScope({ path: '/todos', body: { note: 'see /business-rules-of-ours' } })).toBeUndefined()
  })
})

describe('what a read of the rules answered', () => {
  it('is the same while the rules are, whatever else the answer carries', () => {
    expect(ruleDigest(rule(3, '明细行必须指明产品'))).toBe(ruleDigest(rule(3, '明细行必须指明产品')))
    expect(ruleDigest(rule(4, '明细行必须指明产品'))).not.toBe(ruleDigest(rule(3, '明细行必须指明产品')))
    expect(ruleDigest(rule(3, '明细行必须指明产品和数量'))).not.toBe(ruleDigest(rule(3, '明细行必须指明产品')))
    // None published, then one: that is a change too.
    expect(ruleDigest('{"data":[]}')).not.toBe(ruleDigest(rule(1, 'x')))
    expect(ruleDigest('not json')).toBe(ruleDigest('not json'))
  })
})

describe('rules read earlier in a conversation', () => {
  function setup() {
    const state = { now: 1_000_000, answer: rule(3, '明细行必须指明产品') }
    const replay = vi.fn(async () => state.answer)
    const watch = new RuleWatch(replay, 30_000, () => state.now)
    return { state, replay, watch }
  }

  it('are asked of ORYH again as a later turn starts, and said to be void once they have changed', async () => {
    const { state, replay, watch } = setup()
    watch.read('s', 'oryh_request', dataRule, state.answer)
    expect(watch.notice('s')).toBe('')
    // A turn straight after: nothing is asked again so soon.
    await watch.check('s')
    expect(replay).not.toHaveBeenCalled()
    // Later, unchanged: asked the same way, and nothing to say.
    state.now += 60_000
    await watch.check('s')
    expect(replay).toHaveBeenCalledWith('s', 'oryh_request', dataRule, expect.any(AbortSignal))
    expect(watch.notice('s')).toBe('')
    // The admin publishes a new version.
    state.answer = rule(4, '明细行必须指明产品，并填写承诺交期')
    state.now += 60_000
    await watch.check('s')
    const notice = watch.notice('s')
    expect(notice).toContain('kind=data_rule，object_type=sales_order')
    expect(notice).toContain('已经作废')
    expect(notice).toContain('重新读取')
    // Said until it is read again, and not asked about meanwhile.
    state.now += 60_000
    await watch.check('s')
    expect(replay).toHaveBeenCalledTimes(2)
    expect(watch.notice('s')).toBe(notice)
  })

  it('stop being said once the agent has read them again, by whatever route', async () => {
    const { state, watch } = setup()
    watch.read('s', 'oryh_request', dataRule, state.answer)
    state.answer = rule(4, '新的要求')
    state.now += 60_000
    await watch.check('s')
    expect(watch.notice('s')).not.toBe('')
    // Read again through another tool and with today's date: the same rules, now known as they are.
    watch.read(
      's',
      'oryh_list',
      { collection: 'business-rules', filters: { kind: 'data_rule', object_type: 'sales_order' } },
      state.answer,
    )
    expect(watch.notice('s')).toBe('')
    state.now += 60_000
    await watch.check('s')
    expect(watch.notice('s')).toBe('')
  })

  it('say nothing when ORYH cannot be asked, and ask again the next time', async () => {
    const { state, replay, watch } = setup()
    watch.read('s', 'oryh_request', dataRule, state.answer)
    state.now += 60_000
    replay.mockRejectedValueOnce(new Error('ORYH is away'))
    await watch.check('s')
    expect(watch.notice('s')).toBe('')
    state.answer = rule(4, '新的要求')
    state.now += 60_000
    await watch.check('s')
    expect(watch.notice('s')).not.toBe('')
  })

  it('are kept apart by conversation and by what they are for, and forgotten with the conversation', async () => {
    const { state, replay, watch } = setup()
    const flow = { path: '/business-rules?kind=approval_flow&object_type=sales_order' }
    watch.read('a', 'oryh_request', dataRule, state.answer)
    watch.read('a', 'oryh_request', flow, rule(1, '部门经理审批'))
    watch.read('b', 'oryh_request', flow, rule(1, '部门经理审批'))
    // Only the approval flow changes.
    replay.mockImplementation(async (_s, _t, args) =>
      JSON.stringify(args).includes('data_rule') ? state.answer : rule(2, '总经理审批'),
    )
    state.now += 60_000
    await Promise.all([watch.check('a'), watch.check('b')])
    expect(watch.notice('a')).toContain('kind=approval_flow')
    expect(watch.notice('a')).not.toContain('kind=data_rule')
    expect(watch.notice('b')).toContain('kind=approval_flow')
    watch.forget('a')
    expect(watch.notice('a')).toBe('')
    replay.mockClear()
    state.now += 60_000
    await watch.check('a')
    expect(replay).not.toHaveBeenCalled()
    // Something that is not a read of rules is never asked again.
    watch.read('c', 'oryh_request', { path: '/sales-orders' }, '{"data":[]}')
    state.now += 60_000
    await watch.check('c')
    expect(replay).not.toHaveBeenCalled()
  })

  it('takes the agent’s own later read over an answer that was already on its way', async () => {
    const { state, watch } = setup()
    const slow = { release: () => {} }
    const replay = vi.fn(
      () =>
        new Promise<string>(resolve => {
          slow.release = () => resolve(rule(3, '明细行必须指明产品'))
        }),
    )
    const late = new RuleWatch(replay, 30_000, () => state.now)
    late.read('s', 'oryh_request', dataRule, rule(3, '明细行必须指明产品'))
    state.now += 60_000
    const checking = late.check('s')
    // While ORYH is being asked, the agent reads the new version itself.
    late.read('s', 'oryh_request', dataRule, rule(4, '新的要求'))
    slow.release()
    await checking
    expect(late.notice('s')).toBe('')
    void watch
  })
  it('bounds a stalled replay and retries immediately after cancellation without accepting a late answer', async () => {
    let finish = (_text: string) => {}
    const replay = vi.fn(
      () =>
        new Promise<string>(resolve => {
          finish = resolve
        }),
    )
    const watch = new RuleWatch(replay, 0)
    watch.read('s', 'oryh_request', dataRule, rule(1, 'old'))
    const controller = new AbortController()
    const checking = watch.check('s', controller.signal)
    controller.abort(new Error('deadline'))
    await checking
    finish(rule(2, 'late'))
    await Promise.resolve()
    expect(watch.notice('s')).toBe('')
    replay.mockImplementationOnce(async () => rule(2, 'current'))
    await watch.check('s')
    expect(watch.notice('s')).toContain('已经作废')
  })
})
