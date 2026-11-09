import { dictionaries, english } from '@oryh/ai-client-kit/dictionary'
import { describe, expect, it } from 'vitest'
import { english as analyticsEn } from '../../../client-analytics/src/client/en.js'
import { words as analytics } from '../../../client-analytics/src/client/words.js'
import { english as recordsEn } from '../../../client-records/src/client/en.js'
import { words as records } from '../../../client-records/src/client/words.js'
import { english as todosEn } from '../../../client-todos/src/client/en.js'
import { words as todos } from '../../../client-todos/src/client/words.js'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
describe('complete bilingual product dictionaries', () => {
  for (const [name, zh, en] of [
    ['workspace', dictionaries, english],
    ['tasks', todos, todosEn],
    ['records', records, recordsEn],
    ['pages', analytics, analyticsEn],
  ] as const) {
    it(`${name} has matching keys and substitution fields, with actual English copy`, () => {
      expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
      for (const [key, value] of Object.entries(en)) {
        expect(value.trim(), key).not.toBe('')
        expect(value, key).not.toMatch(/\p{Script=Han}/u)
        expect(placeholders(value), key).toEqual(placeholders((zh as Record<string, string>)[key]!))
        expect(value, key).not.toMatch(/DeepSeek Harness|DSH Local Build|Harness 原生/)
      }
    })
  }
})
