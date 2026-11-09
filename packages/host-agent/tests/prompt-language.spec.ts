import { describe, expect, it } from 'vitest'
import { ASK_RULE, RULES } from '../src/prompts.js'

describe('language of agent-generated decision UI', () => {
  it('keeps English requests English in questions, choices and forms', () => {
    expect(ASK_RULE).toContain('Match the user-requested language')
    expect(ASK_RULE).toContain('English throughout')
    expect(ASK_RULE).toContain('option title and description')
    expect(ASK_RULE).toContain('generated forms and page titles')
    expect(ASK_RULE).toContain('English display labels for built-in menus')
    expect(ASK_RULE).toContain('Do not rename stored business records')
    expect(ASK_RULE).not.toContain('问题和选项都用中文')
    expect(ASK_RULE).toContain('Decline, skip or dismiss means no write')
    expect(ASK_RULE).toContain('Each subsequent write needs its own confirmation')
  })

  it('asks before the first write is sent, however completely the request was put', () => {
    // A request that named the title and the date was taken as leave to write: two POSTs went out to
    // learn the fields before the person was asked anything.
    expect(ASK_RULE).toContain('a complete, specific request is not one')
    const writes = RULES.find(rule => rule.startsWith('写入（'))!
    expect(writes).toContain('被 ORYH 拒绝的写入请求也是写入')
    expect(writes).toContain('不等于不用确认')
  })
})
