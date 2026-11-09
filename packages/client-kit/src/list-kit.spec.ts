import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatDisplayValue } from './list-kit.js'
import { statusLabel, statusTone } from './status-words.js'

/**
 * Pages say shared things through `list-kit.tsx`. Each pattern here is one a page once spelled out by
 * hand, and differently from its neighbours; spelling it out again is how the drift comes back.
 */
const handWritten: [RegExp, string][] = [
  [
    /className="(empty-state|table-footer|pagination|list-loading|business-page-header)"/,
    'EmptyState, ListFooter, ListLoading or PageHeader',
  ],
  [/record-status/, 'StatusPill'],
  [/<Badge\b/, 'StatusPill — status is never a Fluent Badge'],
  [/\bIcon(Refresh|ArrowLeft|ChevronLeft)\b/, 'RefreshButton, BackToList or ListFooter'],
  [/>\s*(打开|查看)\s*</, 'RowOpenCell — rows open with the trailing ">"'],
  [/←/, 'BackToList'],
  [/toLocale(Date|Time)?String\(/, 'formatDate, formatDateTime or formatDisplayValue'],
]

describe('shared page vocabulary', () => {
  const packages = new URL('../../', import.meta.url)
  const pages = readdirSync(packages)
    // The plugins, which keep their browser half under src/client; this package is not one of them.
    .filter(name => name.startsWith('client-') && existsSync(new URL(`${name}/src/client/`, packages)))
    .flatMap(packageName => {
      const dir = new URL(`${packageName}/src/client/`, packages)
      return readdirSync(dir)
        .filter(name => name.endsWith('.tsx') && name !== 'list-kit.tsx')
        .map(name => ({ name: `${packageName}/${name}`, source: readFileSync(new URL(name, dir), 'utf8') }))
    })

  it('reads the plugins it is meant to hold to this', () => {
    expect(pages.length).toBeGreaterThan(10)
  })

  /**
   * 「打开」 that is not a row opening its detail. This check looked in the wrong directory from the day it
   * was written and held nobody to anything; pointed at the plugins, it found these two, which are their
   * own actions: a custom page's row opens the record in ORYH, and the list of custom pages opens a page.
   */
  const opensSomethingElse = new Set(['client-analytics/harness-page.tsx', 'client-analytics/index.tsx'])

  it.each(handWritten)('no page writes %s by hand (use %s)', (pattern, piece) => {
    const allowed = piece.startsWith('RowOpenCell') ? opensSomethingElse : new Set<string>()
    expect(pages.filter(page => pattern.test(page.source) && !allowed.has(page.name)).map(page => page.name)).toEqual(
      [],
    )
  })
})

describe('where the words are', () => {
  const packages = new URL('../../', import.meta.url)
  /** The word lists: the only source files of the client plugins and this library that may hold a sentence. */
  const lists = /(^|\/)(words|kit-words|dictionary|business-locales|copy|timesheet-locale|en)\.ts$/
  const sources = readdirSync(packages)
    // The plugins with a browser half, and this library. One client package ships no source of its own.
    .filter(name => name.startsWith('client-') && existsSync(new URL(`${name}/src/`, packages)))
    .flatMap(packageName => {
      const dir = new URL(
        existsSync(new URL(`${packageName}/src/client/`, packages))
          ? `${packageName}/src/client/`
          : `${packageName}/src/`,
        packages,
      )
      return readdirSync(dir)
        .filter(name => /\.tsx?$/.test(name) && !/\.spec\./.test(name) && !lists.test(name))
        .map(name => ({ name: `${packageName}/${name}`, source: readFileSync(new URL(name, dir), 'utf8') }))
    })
  /** A line that holds text for a person outside a comment. */
  const written = (source: string) => {
    let comment = false
    return source.split('\n').filter(line => {
      const text = line.trim()
      // A comment inside JSX opens with a brace.
      if (text.startsWith('/*') || text.startsWith('{/*')) comment = true
      const skipped = comment || text.startsWith('//') || text.startsWith('*')
      if (text.includes('*/')) comment = false
      return !skipped && /[\u4e00-\u9fff]/.test(line.replace(/\/\/.*$/, ''))
    })
  }
  /**
   * A marker old session records are recognised by is data, not something said to anyone: it has to stay
   * the string those records hold.
   */
  const data = new Set(['client-analytics/chat-form.ts'])

  it('reads the plugins and this library', () => {
    expect(sources.length).toBeGreaterThan(40)
  })
  it('no component or helper writes a sentence of its own: every word is in a word list, read through `t`', () => {
    expect(
      sources
        .filter(file => !data.has(file.name))
        .map(file => [file.name, written(file.source)] as const)
        .filter(([, lines]) => lines.length > 0)
        .map(([name, lines]) => `${name}: ${lines[0]?.trim()}`),
    ).toEqual([])
  })
})

describe('display values', () => {
  it('writes a zoneless timestamp as its wall clock and leaves anything else alone', () => {
    expect(formatDisplayValue('2026-09-01T08:05:00')).toBe('2026-09-01 08:05')
    expect(formatDisplayValue('2026-09-01')).toBe('2026-09-01')
    expect(formatDisplayValue('-1')).toBe('-1')
    expect(formatDisplayValue('PT-HEAD')).toBe('PT-HEAD')
  })

  it('writes a zoned timestamp in local time, to the minute', () => {
    const moment = new Date('2026-09-01T08:05:30Z'),
      pad = (n: number) => String(n).padStart(2, '0')
    expect(formatDisplayValue('2026-09-01T08:05:30Z')).toBe(
      `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`,
    )
    expect(formatDate(moment)).toBe(formatDateTime(moment).slice(0, 10))
    expect(formatDate('not a date')).toBe('not a date')
  })
})

describe('status words', () => {
  it('reads a shipped state the same everywhere and shows a tenant state as the tenant named it', () => {
    expect(statusLabel('approved')).toBe('已通过')
    expect(statusLabel('awaiting_cfo')).toBe('awaiting_cfo')
    // Object prototype names are not status words.
    expect(statusLabel('constructor')).toBe('constructor')
    expect(statusTone('submitted')).toBe('pending')
    expect(statusTone('awaiting_cfo')).toBe('neutral')
  })
})
