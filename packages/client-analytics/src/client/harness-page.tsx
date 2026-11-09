/**
 * A custom page written with Harness components (docs/53): its blocks drawn with DeepSeek Harness's UI
 * primitives, and the table, chart, metric and form pieces Harness does not have, built on its design
 * tokens so they look the same. Everything shown is data, rendered as text or as untrusted Markdown, so the
 * page needs no frame. Sorting, paging, filtering, tabs and sections stay on the page; opening a record,
 * asking Chat and handing a form to the agent go to the page's owner, as they do from a framed page.
 */
import {
  Button,
  Checkbox,
  DisclosureRow,
  Input,
  MarkdownText,
  Pill,
  type SegmentedTab,
  SegmentedTabs,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CustomAsk,
  CustomBlock,
  CustomBoundField,
  CustomComputed,
  CustomForm,
  CustomFormField,
} from '@oryh/dsh-analytics/types'
import type { FormValue } from '@oryh/dsh-pane/types'
import { Fragment, type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react'

import { describeForm, formChoices, formPlaceFormat, formPlaceLabel, withLineDefaults } from './form-chat.js'
import { formatValue } from './format.js'
import type { Words } from './words.js'

export { formatValue } from './format.js'

import {
  ChatFillNote,
  type ChatFormRegistry,
  filledMark,
  type PageFace,
  useChatFill,
  useChatForm,
  writtenRowProps,
} from '@oryh/ai-client-kit'

type Row = Record<string, unknown>
type Data = Record<string, unknown>
/** What handing a form over came to, in words for the person. */
export interface HarnessFormResult {
  ok: boolean
  message: string
  cancelled?: boolean | undefined
}
/** What a page asks of its owner: the row it means is named by its path in the result, such as `rows.3`. */
export interface HarnessActions {
  open(row: string, target: string): void
  ask(row: string, question: string): void
  submit(form: string, row: string, values: Record<string, unknown>): Promise<HarnessFormResult>
  /**
   * A form holds something the person typed, or no longer does. The owner reports it, and while any does
   * Chat leaves the workbench on this page unless asked to show another.
   */
  editing?(form: string, dirty: boolean): void
}

/**
 * What a Markdown block's own controls are called. Made once for a page and handed down: MarkdownText keys
 * its render cache by the labels' identity.
 * @param t - this plugin's words.
 */
function markdownLabels(t: Words) {
  return {
    code: { copyLabel: t('harnessCodeCopy'), copiedLabel: t('harnessCodeCopied') },
    footnotes: t('harnessFootnotes'),
  }
}
type MarkdownLabels = ReturnType<typeof markdownLabels>
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*(?:\|\s*([a-z]+)\s*)?\}\}/g
/** The chart colors: Harness's state colors, in turn. */
const PALETTE = ['business-primary', 'success-primary', 'warn-primary', 'idle-primary', 'error-primary'].map(
  name => `var(--dsw-alias-state-${name})`,
)

/** A number from a value that may be written with thousands separators, or NaN. */
function numeric(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN
  return Number(value.replaceAll(',', ''))
}
/**
 * A markdown block's text with its `{{field}}` values written in, as text that Markdown cannot read as
 * syntax, and its images as their alt text: a page loads nothing from anywhere else. Any other `![` that
 * would still open an image, such as one by reference, is escaped, so Markdown reads it as text.
 */
export function fillMarkdown(text: string, data: Data): string {
  const literal = (value: string) => value.replace(/\s+/g, ' ').replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&')
  return (
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // An odd run of backslashes before the `!` has escaped it already.
      .replace(/(\\*)!\[/g, (match, slashes: string) => (slashes.length % 2 ? match : `${slashes}\\![`))
      .replace(PLACEHOLDER, (_match, name: string, format?: string) => literal(formatValue(data[name], format)))
  )
}
/**
 * Markdown the model wrote. A link in it shows its words and goes nowhere, as a framed page may not link
 * either: a page sends no one elsewhere, least of all with its data in the address.
 */
function Markdown({ text, labels }: { text: string; labels: MarkdownLabels }): ReactNode {
  return (
    <div className="harness-markdown" onClickCapture={stayOnPage} onAuxClickCapture={stayOnPage}>
      <MarkdownText text={text} labels={labels} />
    </div>
  )
}
function stayOnPage(event: MouseEvent): void {
  if (!(event.target instanceof Element) || !event.target.closest('a')) return
  event.preventDefault()
  event.stopPropagation()
}

interface Filter {
  key: string
  targets: string[]
  field?: string | undefined
  control: 'text' | 'select' | 'pills'
}
/** A record a Chat turn wrote: its collection as the path names it, and its id. */
export interface WrittenRecord {
  collection: string
  id: string
}

/**
 * Whether a table row is a record Chat just wrote.
 * @param open - the table's `open` target, `object_type:field`: what kind of record a row is, and where
 *   its id is.
 * @param row - the row.
 * @param written - what the turn wrote.
 */
export function rowWritten(open: string | undefined, row: Row, written: readonly WrittenRecord[]): boolean {
  if (open === undefined || written.length === 0) return false
  const [type, field] = open.split(':')
  const id = field === undefined ? undefined : row[field]
  if (typeof id !== 'string' && typeof id !== 'number') return false
  return written.some(
    record =>
      record.id === String(id) &&
      record.collection.replace(/ies$/, 'y').replace(/s$/, '').replaceAll('-', '_') === type,
  )
}
/** What every block of a page is drawn with, handed down from the page as a prop. */
interface PageState {
  face: PageFace
  /** This plugin's words; the frame's shared ones are `face.frame.t`. */
  t: Words
  labels: MarkdownLabels
  /** Where the page's forms describe themselves to Chat, when its owner collects them. */
  registry: ChatFormRegistry | undefined
  written: readonly WrittenRecord[]
  data: Data
  forms: readonly CustomForm[]
  fixedText: string
  actions: HarnessActions
  filters: readonly Filter[]
  queries: Record<string, string>
  setQuery(key: string, value: string): void
}
/** The items of a top-level array, each with its path in the result, narrowed by the page's filters. */
function useItems(page: PageState, data: string): { row: Row; path: string }[] {
  const { data: result, filters, queries } = page
  return useMemo(() => {
    const items = Array.isArray(result[data]) ? (result[data] as unknown[]) : []
    const active = filters.filter(filter => filter.targets.includes(data) && (queries[filter.key] ?? '') !== '')
    return items.flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const row = item as Row
      const passes = active.every(filter => {
        const query = queries[filter.key]!
        if (filter.control !== 'text') return formatValue(row[filter.field!]) === query
        const needle = query.trim().toLowerCase()
        const values = filter.field ? [row[filter.field]] : Object.values(row)
        return values.some(value => formatValue(value).toLowerCase().includes(needle))
      })
      return passes ? [{ row, path: `${data}.${index}` }] : []
    })
  }, [result, data, filters, queries])
}

/** Every filter block of the page, found once, with a key its query is kept under. */
function filtersOf(blocks: readonly CustomBlock[], path = 'b'): Filter[] {
  return blocks.flatMap((block, index): Filter[] => {
    const key = `${path}${index}`
    if (block.type === 'filter') return [{ key, targets: block.targets, field: block.field, control: block.control }]
    if (block.type === 'tabs') return block.tabs.flatMap((tab, t) => filtersOf(tab.blocks, `${key}t${t}`))
    if (block.type === 'section') return filtersOf(block.blocks, `${key}s`)
    return []
  })
}

/**
 * The page.
 * @param props.blocks - the page's blocks.
 * @param props.data - the published result for the page's version.
 * @param props.forms - the page's declared forms.
 * @param props.fixedText - the page's fixed text.
 * @param props.actions - what the owner does for a row or a form.
 * @param props.t - this plugin's words.
 */
export function HarnessPage(props: {
  blocks: readonly CustomBlock[]
  data: Data
  forms: readonly CustomForm[]
  fixedText: string
  actions: HarnessActions
  face: PageFace
  t: Words
  /** The owner's registry of the page's forms, from `useChatForms`; without one Chat does not see them. */
  registry?: ChatFormRegistry
  /** The records Chat's last writing turn named, for the tables to point out. */
  written?: readonly WrittenRecord[]
}): ReactNode {
  const [queries, setQueries] = useState<Record<string, string>>({})
  const filters = useMemo(() => filtersOf(props.blocks), [props.blocks])
  const labels = useMemo(() => markdownLabels(props.t), [props.t])
  const state: PageState = {
    face: props.face,
    t: props.t,
    labels,
    registry: props.registry,
    written: props.written ?? [],
    data: props.data,
    forms: props.forms,
    fixedText: props.fixedText,
    actions: props.actions,
    filters,
    queries,
    setQuery: (key, value) => setQueries(current => ({ ...current, [key]: value })),
  }
  return (
    <div className="harness-page">
      <Blocks page={state} blocks={props.blocks} path="b" />
    </div>
  )
}

function Blocks({ page, blocks, path }: { page: PageState; blocks: readonly CustomBlock[]; path: string }): ReactNode {
  return blocks.map((block, index) => (
    <Block key={`${path}${index}`} page={page} block={block} path={`${path}${index}`} />
  ))
}

function Block({ page, block, path }: { page: PageState; block: CustomBlock; path: string }): ReactNode {
  switch (block.type) {
    case 'markdown':
      return <Markdown text={fillMarkdown(block.text, page.data)} labels={page.labels} />
    case 'fixed':
      return page.fixedText ? <Markdown text={fillMarkdown(page.fixedText, {})} labels={page.labels} /> : null
    case 'metrics':
      return (
        <div className="harness-metrics">
          {block.items.map(item => (
            <div className="harness-metric" key={item.field}>
              <span>{item.label}</span>
              <strong>{formatValue(page.data[item.field], item.format)}</strong>
            </div>
          ))}
        </div>
      )
    case 'table':
      return <Table page={page} block={block} />
    case 'list':
      return <List page={page} block={block} />
    case 'chart':
      return <Chart page={page} block={block} />
    case 'filter':
      return <FilterControl page={page} block={block} filterKey={path} />
    case 'tabs':
      return <Tabs page={page} block={block} path={path} />
    case 'section':
      return <Section page={page} block={block} path={path} />
    case 'form': {
      const form = page.forms.find(item => item.name === block.name)
      return form ? <FormView page={page} form={form} row="" /> : null
    }
  }
}

/** What a row can do: open its record, ask Chat about it, fill in its form. */
function RowActions({
  page,
  row,
  path,
  open,
  ask,
  form,
  formOpen,
  onForm,
}: {
  page: PageState
  row: Row
  path: string
  open?: string | undefined
  ask?: CustomAsk[] | undefined
  form?: string | undefined
  formOpen: boolean
  onForm: () => void
}): ReactNode {
  const { actions, forms, t } = page
  const canOpen = open !== undefined && ['string', 'number'].includes(typeof row[open.split(':')[1]!])
  return (
    <span className="harness-row-actions">
      {canOpen && (
        <Button size="sm" variant="ghost" onClick={() => actions.open(path, open!)}>
          {t('harnessRowOpen')}
        </Button>
      )}
      {(ask ?? []).map(item => (
        <Button key={item.question} size="sm" variant="ghost" onClick={() => actions.ask(path, item.question)}>
          {item.label}
        </Button>
      ))}
      {form !== undefined && (
        <Button size="sm" variant={formOpen ? 'outline' : 'ghost'} onClick={onForm}>
          {/* Named as the form is, so a row with a form reads 跟进 or 补单, not a bare 填写. */}
          {formOpen ? t('harnessFormClose') : (forms.find(item => item.name === form)?.label ?? t('harnessFormFill'))}
        </Button>
      )}
      {/* A page that declared no question of its own still lets every row be asked about, after its own actions. */}
      {!ask?.length && (
        // The Host admits this question for any row, by these words (host-analytics custom-model.ts).
        <Button size="sm" variant="ghost" onClick={() => actions.ask(path, t('harnessRowQuestion'))}>
          {page.face.frame.t('askAi')}
        </Button>
      )}
    </span>
  )
}

function Table({ page, block }: { page: PageState; block: Extract<CustomBlock, { type: 'table' }> }): ReactNode {
  const items = useItems(page, block.data)
  const { forms, written, t } = page
  const frameT = page.face.frame.t
  const [sort, setSort] = useState<{ field: string; down: boolean }>()
  const [pageIndex, setPage] = useState(0)
  const [formRow, setFormRow] = useState<string>()
  const sortable = block.sortable !== false
  const size = block.pageSize ?? 50
  const sorted = useMemo(() => {
    if (!sort) return items
    const direction = sort.down ? -1 : 1
    return [...items].sort((a, b) => {
      const x = a.row[sort.field]
      const y = b.row[sort.field]
      const [m, n] = [numeric(x), numeric(y)]
      if (Number.isFinite(m) && Number.isFinite(n)) return (m - n) * direction
      return formatValue(x).localeCompare(formatValue(y), 'zh-CN') * direction
    })
  }, [items, sort])
  const pages = Math.max(1, Math.ceil(sorted.length / size))
  const current = Math.min(pageIndex, pages - 1)
  const shown = sorted.slice(current * size, current * size + size)
  const form = forms.find(item => item.name === block.form)
  const header = (column: CustomBoundField) => {
    if (!sortable) return column.label
    const active = sort?.field === column.field
    return (
      <button
        type="button"
        className="harness-sort"
        aria-sort={active ? (sort!.down ? 'descending' : 'ascending') : 'none'}
        onClick={() =>
          setSort(active ? { field: column.field, down: !sort!.down } : { field: column.field, down: false })
        }
      >
        {column.label}
        {active ? (sort!.down ? ' ↓' : ' ↑') : ''}
      </button>
    )
  }
  return (
    <div className="harness-table">
      <table>
        <thead>
          <tr>
            {block.columns.map(column => (
              <th key={column.field} data-numeric={column.format && column.format !== 'date' ? '' : undefined}>
                {header(column)}
              </th>
            ))}
            <th aria-label={frameT('rowActions')} />
          </tr>
        </thead>
        <tbody>
          {shown.map(({ row, path }) => (
            <Fragment key={path}>
              <tr {...writtenRowProps(frameT, rowWritten(block.open, row, written))}>
                {block.columns.map(column => {
                  const value = formatValue(row[column.field], column.format)
                  return (
                    <td
                      key={column.field}
                      title={value}
                      data-numeric={column.format && column.format !== 'date' ? '' : undefined}
                    >
                      {value}
                    </td>
                  )
                })}
                <td className="harness-actions-cell">
                  <RowActions
                    page={page}
                    row={row}
                    path={path}
                    open={block.open}
                    ask={block.ask}
                    form={block.form}
                    formOpen={formRow === path}
                    onForm={() => setFormRow(formRow === path ? undefined : path)}
                  />
                </td>
              </tr>
              {form && formRow === path && (
                <tr className="harness-row-form">
                  <td colSpan={block.columns.length + 1}>
                    <FormView page={page} form={form} row={path} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="harness-empty">{t('harnessEmpty')}</p>}
      {pages > 1 && (
        <div className="harness-pager">
          <Button size="sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
            {frameT('footerPrevious')}
          </Button>
          <span>{t('harnessPagerPosition', { page: current + 1, pages, count: sorted.length })}</span>
          <Button size="sm" variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            {frameT('footerNext')}
          </Button>
        </div>
      )}
    </div>
  )
}
function List({ page, block }: { page: PageState; block: Extract<CustomBlock, { type: 'list' }> }): ReactNode {
  const items = useItems(page, block.data)
  const { forms, t } = page
  const [formRow, setFormRow] = useState<string>()
  const form = forms.find(item => item.name === block.form)
  return (
    <div className="harness-list">
      {items.map(({ row, path }) => (
        <article key={path} className="harness-card">
          <strong>{formatValue(row[block.title])}</strong>
          {block.summary !== undefined && <p>{formatValue(row[block.summary])}</p>}
          {(block.meta?.length ?? 0) > 0 && (
            <dl>
              {block.meta!.map(item => (
                <div key={item.field}>
                  <dt>{item.label}</dt>
                  <dd>{formatValue(row[item.field], item.format)}</dd>
                </div>
              ))}
            </dl>
          )}
          <RowActions
            page={page}
            row={row}
            path={path}
            open={block.open}
            ask={block.ask}
            form={block.form}
            formOpen={formRow === path}
            onForm={() => setFormRow(formRow === path ? undefined : path)}
          />
          {form && formRow === path && <FormView page={page} form={form} row={path} />}
        </article>
      ))}
      {items.length === 0 && <p className="harness-empty">{t('harnessEmpty')}</p>}
    </div>
  )
}

function Chart({ page, block }: { page: PageState; block: Extract<CustomBlock, { type: 'chart' }> }): ReactNode {
  const items = useItems(page, block.data)
  const { t } = page
  // One bar, point or slice per label: a chart "by customer" over orders sums each customer's orders.
  const points = [
    ...items
      .map(({ row }) => ({ label: formatValue(row[block.label]), value: numeric(row[block.value]) }))
      .filter(point => Number.isFinite(point.value))
      .reduce(
        (merged, point) => merged.set(point.label, (merged.get(point.label) ?? 0) + point.value),
        new Map<string, number>(),
      ),
  ].map(([label, value]) => ({ label, value }))
  const title = block.title ?? ''
  if (points.length === 0)
    return (
      <figure className="harness-chart">
        {title && <figcaption>{title}</figcaption>}
        <p className="harness-empty">{t('harnessChartEmpty')}</p>
      </figure>
    )
  return (
    <figure className="harness-chart" aria-label={title || t('harnessChart')}>
      {title && <figcaption>{title}</figcaption>}
      {block.kind === 'bar' ? (
        <Bars points={points} />
      ) : block.kind === 'line' ? (
        <Line t={t} points={points} />
      ) : (
        <Pie t={t} points={points} />
      )}
    </figure>
  )
}
function Bars({ points }: { points: { label: string; value: number }[] }): ReactNode {
  const max = Math.max(...points.map(point => Math.abs(point.value)), 1)
  return (
    <div className="harness-bars">
      {points.map((point, index) => (
        <div className="harness-bar" key={`${point.label}${index}`}>
          <span title={point.label}>{point.label}</span>
          <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <rect width={(Math.abs(point.value) / max) * 100} height="10" rx="1.5" fill={PALETTE[0]} />
          </svg>
          <strong>{formatValue(point.value, 'number')}</strong>
        </div>
      ))}
    </div>
  )
}
function Line({ t, points }: { t: Words; points: { label: string; value: number }[] }): ReactNode {
  const width = 600
  const height = 220
  const pad = 28
  const values = points.map(point => point.value)
  const [low, high] = [Math.min(...values, 0), Math.max(...values, 0)]
  const span = high - low || 1
  const x = (index: number) =>
    pad + (points.length === 1 ? (width - 2 * pad) / 2 : (index * (width - 2 * pad)) / (points.length - 1))
  const y = (value: number) => height - pad - ((value - low) / span) * (height - 2 * pad)
  return (
    <svg className="harness-line" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('harnessLineChart')}>
      <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} className="harness-axis" />
      <polyline
        fill="none"
        stroke={PALETTE[0]}
        strokeWidth="2"
        points={points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ')}
      />
      {points.map((point, index) => (
        <g key={`${point.label}${index}`}>
          <circle cx={x(index)} cy={y(point.value)} r="3" fill={PALETTE[0]}>
            <title>{t('harnessPointTitle', { label: point.label, value: formatValue(point.value, 'number') })}</title>
          </circle>
          {(points.length <= 12 || index % Math.ceil(points.length / 12) === 0) && (
            <text x={x(index)} y={height - 8} textAnchor="middle">
              {point.label.slice(0, 10)}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}
function Pie({ t, points }: { t: Words; points: { label: string; value: number }[] }): ReactNode {
  // Past eight slices the rest reads as one: a pie of thirty slivers says nothing.
  const positive = points.filter(point => point.value > 0).sort((a, b) => b.value - a.value)
  const slices =
    positive.length > 8
      ? [
          ...positive.slice(0, 7),
          { label: t('harnessPieOther'), value: positive.slice(7).reduce((sum, p) => sum + p.value, 0) },
        ]
      : positive
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1
  let angle = -Math.PI / 2
  const arcs = slices.map((slice, index) => {
    const start = angle
    angle += (slice.value / total) * Math.PI * 2
    const large = angle - start > Math.PI ? 1 : 0
    const point = (a: number) => `${50 + 45 * Math.cos(a)},${50 + 45 * Math.sin(a)}`
    const whole = slices.length === 1
    return {
      ...slice,
      color: PALETTE[index % PALETTE.length]!,
      d: whole ? '' : `M50,50 L${point(start)} A45,45 0 ${large} 1 ${point(angle)} Z`,
      whole,
    }
  })
  return (
    <div className="harness-pie">
      <svg viewBox="0 0 100 100" role="img" aria-label={t('harnessPieChart')}>
        {arcs.map(arc =>
          arc.whole ? (
            <circle key={arc.label} cx="50" cy="50" r="45" fill={arc.color} />
          ) : (
            <path key={arc.label} d={arc.d} fill={arc.color}>
              <title>{t('harnessPointTitle', { label: arc.label, value: formatValue(arc.value, 'number') })}</title>
            </path>
          ),
        )}
      </svg>
      <ul>
        {arcs.map(arc => (
          <li key={arc.label}>
            <i style={{ background: arc.color }} />
            {arc.label}
            <span>{formatValue(arc.value / total, 'percent')}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FilterControl({
  page,
  block,
  filterKey,
}: {
  page: PageState
  block: Extract<CustomBlock, { type: 'filter' }>
  filterKey: string
}): ReactNode {
  const { data, queries, setQuery, t } = page
  const query = queries[filterKey] ?? ''
  // The values to choose from are the field's own, over every array the filter narrows.
  const options = useMemo(() => {
    if (block.control === 'text' || !block.field) return []
    const seen = new Set<string>()
    for (const target of block.targets)
      for (const item of Array.isArray(data[target]) ? (data[target] as unknown[]) : [])
        if (item && typeof item === 'object') {
          const value = formatValue((item as Row)[block.field])
          if (value !== '') seen.add(value)
        }
    return [...seen].sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, 50)
  }, [block, data])
  if (block.control === 'text')
    return (
      <label className="harness-filter">
        <span>{block.label}</span>
        <Input
          value={query}
          placeholder={t('harnessFilterPlaceholder')}
          onChange={event => setQuery(filterKey, event.target.value)}
        />
      </label>
    )
  if (block.control === 'select')
    return (
      <label className="harness-filter">
        <span>{block.label}</span>
        <select className="harness-select" value={query} onChange={event => setQuery(filterKey, event.target.value)}>
          <option value="">{t('filterAll')}</option>
          {options.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    )
  return (
    <div className="harness-filter" role="group" aria-label={block.label}>
      <span>{block.label}</span>
      <Pill active={query === ''} onClick={() => setQuery(filterKey, '')}>
        {t('filterAll')}
      </Pill>
      {options.map(option => (
        <Pill
          key={option}
          active={query === option}
          onClick={() => setQuery(filterKey, query === option ? '' : option)}
        >
          {option}
        </Pill>
      ))}
    </div>
  )
}

function Tabs({
  page,
  block,
  path,
}: {
  page: PageState
  block: Extract<CustomBlock, { type: 'tabs' }>
  path: string
}): ReactNode {
  const [value, setValue] = useState('0')
  const items = block.tabs.map((tab, index) => ({
    value: String(index),
    label: tab.label,
    id: `${path}-tab-${index}`,
    panelId: `${path}-panel-${index}`,
  })) as unknown as readonly [SegmentedTab<string>, ...SegmentedTab<string>[]]
  const index = Number(value)
  return (
    <div className="harness-tabs">
      <SegmentedTabs items={items} value={value} onChange={setValue} label={page.t('harnessTabs')} />
      <div role="tabpanel" id={`${path}-panel-${index}`} aria-labelledby={`${path}-tab-${index}`}>
        <Blocks page={page} blocks={block.tabs[index]!.blocks} path={`${path}t${index}`} />
      </div>
    </div>
  )
}

function Section({
  page,
  block,
  path,
}: {
  page: PageState
  block: Extract<CustomBlock, { type: 'section' }>
  path: string
}): ReactNode {
  const [open, setOpen] = useState(!block.collapsed)
  const body = <Blocks page={page} blocks={block.blocks} path={`${path}s`} />
  if (!block.collapsible)
    return (
      <section className="harness-section">
        <h3>{block.title}</h3>
        {body}
      </section>
    )
  return (
    <div className="harness-section">
      <DisclosureRow icon={null} title={block.title} open={open} expandable onToggle={() => setOpen(!open)}>
        {open ? body : null}
      </DisclosureRow>
    </div>
  )
}

type Line = Record<string, string | boolean>
/** An empty line, or an empty form, of these fields. */
function blank(fields: readonly CustomFormField[]): Line {
  return Object.fromEntries(fields.map(field => [field.name, field.type === 'checkbox' ? false : '']))
}
function start(form: CustomForm): { values: Line; lines: Record<string, Line[]> } {
  const plain = form.fields.filter(field => field.type !== 'lines')
  const lines = Object.fromEntries(
    form.fields
      .filter(field => field.type === 'lines')
      .map(field => [field.name, Array.from({ length: Math.max(field.min ?? 0, 1) }, () => blank(field.fields ?? []))]),
  )
  return { values: blank(plain), lines }
}
function lineFigure(line: Line, item: CustomComputed): number {
  if (item.zeroWhen && line[item.zeroWhen] === true) return 0
  if (!item.multiply) return Number.NaN
  return numeric(line[item.multiply[0]]) * numeric(line[item.multiply[1]])
}

/**
 * A declared form, laid out from its definition: its fields, its lines with their figures, and its sums.
 * Values go to the owner as the framed page sends them — text as typed, a checkbox as a boolean, lines as
 * a list — and the Host holds each to its field before the person confirms.
 */
function FormView({ page, form, row }: { page: PageState; form: CustomForm; row: string }): ReactNode {
  const { data, actions, face, registry, t } = page
  const [state, setState] = useState(() => start(form))
  const [status, setStatus] = useState<{ kind: 'pending' | 'ok' | 'error' | 'muted'; message: string }>()
  // The form as Chat reads it and as a fill of it is kept: its fields and its lines in one record, by name.
  const whole = useMemo<Record<string, FormValue>>(() => ({ ...state.values, ...state.lines }), [state])
  // What the agent's last fill changed, so the form can mark it and offer to take it back.
  const fill = useChatFill(face.frame.activity, whole)
  const put = (next: Record<string, FormValue>) =>
    setState({
      values: Object.fromEntries(Object.entries(next).filter(([, value]) => !Array.isArray(value))) as Line,
      lines: Object.fromEntries(Object.entries(next).filter(([, value]) => Array.isArray(value))) as Record<
        string,
        Line[]
      >,
    })
  const pristine = useMemo(() => JSON.stringify(start(form)), [form])
  const dirty = JSON.stringify(state) !== pristine
  useEffect(() => {
    const key = `${form.name}:${row}`
    actions.editing?.(key, dirty)
    return () => actions.editing?.(key, false)
  }, [actions, form.name, row, dirty])
  const choices = (field: CustomFormField) => formChoices(field, data)
  // The form describes itself to the agent — its fields, and its lines with their columns — and takes
  // what Chat fills, field by field; lines come as the whole list (docs/56 §15).
  useChatForm(registry, {
    id: row ? `${form.name}:${row}` : form.name,
    label: form.label,
    fields: describeForm(form, data),
    values: whole,
    busy: status?.kind === 'pending',
    onFill: next => {
      const filled = withLineDefaults(form, data, next, whole)
      fill.record(whole, filled)
      put(filled)
    },
  })
  const sums: Record<string, number> = {}
  for (const field of form.fields)
    if (field.type === 'lines')
      for (const line of state.lines[field.name] ?? []) {
        for (const item of field.computed ?? []) {
          const value = lineFigure(line, item)
          if (Number.isFinite(value))
            sums[`${field.name}.${item.name}`] = (sums[`${field.name}.${item.name}`] ?? 0) + value
        }
        for (const sub of field.fields ?? []) {
          const value = numeric(line[sub.name])
          if (Number.isFinite(value))
            sums[`${field.name}.${sub.name}`] = (sums[`${field.name}.${sub.name}`] ?? 0) + value
        }
      }
  const setValue = (name: string, value: string | boolean) =>
    setState(current => ({ ...current, values: { ...current.values, [name]: value } }))
  const setLine = (lines: string, index: number, change: Line) =>
    setState(current => ({
      ...current,
      lines: {
        ...current.lines,
        [lines]: current.lines[lines]!.map((line, i) => (i === index ? { ...line, ...change } : line)),
      },
    }))
  const input = (field: CustomFormField, value: string | boolean, onChange: (value: string | boolean) => void) => {
    const id = `${form.name}-${row}-${field.name}`
    switch (field.type) {
      case 'checkbox':
        return <Checkbox checked={value === true} label={field.label} onChange={onChange} />
      case 'textarea':
        return (
          <textarea
            className="harness-textarea"
            aria-label={field.label}
            value={String(value)}
            onChange={event => onChange(event.target.value)}
          />
        )
      case 'select': {
        const options = choices(field)
        return (
          <select
            className="harness-select"
            aria-label={field.label}
            id={id}
            value={String(value)}
            onChange={event => onChange(event.target.value)}
          >
            <option value="">{t('formChoose')}</option>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )
      }
      default:
        return (
          <Input
            aria-label={field.label}
            type={field.type === 'date' ? 'date' : 'text'}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            value={String(value)}
            onChange={event => onChange(event.target.value)}
          />
        )
    }
  }
  async function submit() {
    // Held while the agent that filled it is still at work: more of the form may be on its way.
    if (status?.kind === 'pending' || fill.writing) return
    setStatus({ kind: 'pending', message: t('formWaiting') })
    const values: Record<string, unknown> = { ...state.values }
    for (const [name, lines] of Object.entries(state.lines)) values[name] = lines
    const result = await actions.submit(form.name, row, values)
    setStatus({ kind: result.ok ? 'ok' : result.cancelled ? 'muted' : 'error', message: result.message })
    if (result.ok) setState(start(form))
  }
  return (
    <form
      className="harness-form"
      aria-label={form.label}
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
    >
      <ChatFillNote
        t={face.frame.t}
        fill={fill}
        label={path => formPlaceLabel(t, form, path)}
        format={(path, value) => formPlaceFormat(form, data, path, value)}
        onUndo={put}
      >
        {t('harnessFormPending')}
      </ChatFillNote>
      {form.fields.map(field => {
        if (field.type !== 'lines')
          return (
            <label key={field.name} className="harness-field" {...filledMark(fill, field.name)}>
              {field.type !== 'checkbox' && (
                <span>
                  {field.label}
                  {field.required ? ' *' : ''}
                </span>
              )}
              {input(field, state.values[field.name] ?? '', value => setValue(field.name, value))}
            </label>
          )
        const lines = state.lines[field.name] ?? []
        return (
          <fieldset key={field.name} className="harness-lines">
            <legend>{field.label}</legend>
            {lines.map((line, index) => (
              <div className="harness-line" key={index}>
                {(field.fields ?? []).map(sub => (
                  <label
                    key={sub.name}
                    className="harness-field"
                    {...filledMark(fill, `${field.name}.${index}.${sub.name}`)}
                  >
                    {sub.type !== 'checkbox' && <span>{sub.label}</span>}
                    {input(sub, line[sub.name] ?? '', value => {
                      const change: Line = { [sub.name]: value }
                      // A select with defaults fills the line from the chosen item.
                      if (sub.type === 'select' && sub.defaults) {
                        const chosen = choices(sub).find(option => option.value === value)
                        for (const [target, source] of Object.entries(sub.defaults)) {
                          const v = chosen?.item?.[source]
                          if (v !== undefined && v !== null) change[target] = formatValue(v)
                        }
                      }
                      setLine(field.name, index, change)
                    })}
                  </label>
                ))}
                {(field.computed ?? []).map(item => (
                  <output key={item.name} aria-label={item.label}>
                    {item.label} {formatValue(lineFigure(line, item), 'number').replace('NaN', '')}
                  </output>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={lines.length <= (field.min ?? 0)}
                  onClick={() =>
                    setState(current => ({
                      ...current,
                      lines: { ...current.lines, [field.name]: lines.filter((_, i) => i !== index) },
                    }))
                  }
                >
                  {t('formLineRemove')}
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={lines.length >= (field.max ?? 50)}
              onClick={() =>
                setState(current => ({
                  ...current,
                  lines: { ...current.lines, [field.name]: [...lines, blank(field.fields ?? [])] },
                }))
              }
            >
              {t('formLineAdd')}
            </Button>
          </fieldset>
        )
      })}
      {(form.computed ?? []).map(item => (
        <output key={item.name} className="harness-total" aria-label={item.label}>
          {item.label} {formatValue(item.sum ? (sums[item.sum] ?? 0) : 0, 'number')}
        </output>
      ))}
      <div className="harness-form-actions">
        <Button variant="primary" type="submit" disabled={status?.kind === 'pending' || fill.writing}>
          {form.label}
        </Button>
        {status && (
          <span className="harness-form-status" data-kind={status.kind}>
            {status.message}
          </span>
        )}
      </div>
    </form>
  )
}
