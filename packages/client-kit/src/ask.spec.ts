import { describe, expect, it } from 'vitest'
import { errorQuestion } from './ask.js'
import { dictionaries } from './dictionary.js'
import { wordsOf } from './pane-test.js'

const t = wordsOf(dictionaries)

describe('what a page asks the agent', () => {
  it('asks about the open record in words that need the page beside them, and nothing else', () => {
    // The agent reads the page in its context; the Host says which page the question came from.
    expect(t('askRecordQuestion')).toMatch(/这条记录/)
    expect(t('askRecordQuestion').length).toBeLessThanOrEqual(500)
  })

  it('quotes an error as the page showed it, cut where a long one would crowd the question out', () => {
    expect(errorQuestion(t, 'Not found')).toBe('页面上出现了这个错误：Not found。这是什么原因，我该怎么处理？')
    expect(errorQuestion(t, 'x'.repeat(2000)).length).toBeLessThanOrEqual(500)
  })
})
