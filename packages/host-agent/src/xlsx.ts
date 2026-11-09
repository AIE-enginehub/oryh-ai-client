/**
 * Reading an .xlsx workbook, as much of it as a model needs: its sheets and their cells' values.
 *
 * A workbook is a zip of XML parts. The library first used here read only the spelling Excel itself
 * writes, and the first real file a person attached was not that: exported by a shop platform, its every
 * element carried a namespace prefix (`<x:row>`) and its relationships pointed from the package root
 * (`/xl/worksheets/sheet1.xml`). Both are as valid as Excel's own. So the parts are read here directly,
 * by local name and with either kind of target, and nothing about styling, formulas or drawing is.
 */
import { XMLParser } from 'fast-xml-parser'
import { strFromU8, unzipSync } from 'fflate'

/** The most a workbook may unpack to: a sheet of a few megabytes zipped is tens unpacked, a bomb is more. */
const MAX_UNPACKED = 200 * 1024 * 1024

export type Cell = string | number | boolean | null

export interface Sheet {
  readonly name: string
  /** Rows that hold anything, each with its number in the sheet; cells run from column A. */
  readonly rows: readonly { readonly row: number; readonly cells: Cell[] }[]
  readonly columns: number
}

type Node = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // `x:row` and `row` are the same element.
  removeNSPrefix: true,
  // A cell's text is text: `007` stays `007`, and the spaces around it stay too.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: name => ['sheet', 'Relationship', 'si', 'r', 'row', 'c', 'xf', 'numFmt'].includes(name),
})

const list = (value: unknown): Node[] => (Array.isArray(value) ? (value as Node[]) : [])
const node = (value: unknown): Node => (value && typeof value === 'object' ? (value as Node) : {})
/** An element's text, whether it has attributes (`#text`) or not. */
const text = (value: unknown): string =>
  typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as Node)['#text'] ?? '') : ''

/** A part's path from a relationship target, which may be relative to its source or from the root. */
function partPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = [...base.split('/').slice(0, -1), ...target.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return out.join('/')
}

/** Built-in number formats that show a date or a time (ECMA-376 §18.8.30, with the East Asian ones). */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47])
for (let id = 50; id <= 58; id++) DATE_FORMATS.add(id)

/** Whether a custom format shows a date: it names a day, month, year, hour or second outside quotes. */
function showsDate(format: string): boolean {
  const bare = format
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
  return /[dmyhs]/i.test(bare) && !/^[#0?.,% E+-]*$/.test(bare) && !/general/i.test(bare)
}

/** A serial day number as the date it shows. */
function serialDate(serial: number, from1904: boolean): string {
  // Day 0 is 1899-12-30 once Lotus's leap day of 1900 is allowed for; a 1904 workbook starts 1462 days on.
  const ms = Math.round((serial + (from1904 ? 1462 : 0)) * 86_400_000) + Date.UTC(1899, 11, 30)
  const iso = new Date(ms).toISOString()
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

/** A column's number from a cell reference: `A1` is 0, `AB12` is 27. */
function columnOf(reference: string): number {
  let column = 0
  for (const letter of /^[A-Za-z]+/.exec(reference)?.[0].toUpperCase() ?? '')
    column = column * 26 + letter.charCodeAt(0) - 64
  return column - 1
}

/**
 * Read a workbook's sheets.
 * @param data - the file's bytes.
 * @returns every visible sheet's rows, in the workbook's order.
 * @throws when the bytes are not a workbook this can read.
 */
export function readXlsx(data: Uint8Array): Sheet[] {
  let unpacked = 0
  const files = unzipSync(data, {
    filter: file => {
      unpacked += file.originalSize
      if (unpacked > MAX_UNPACKED) throw new Error('workbook too large')
      return /\.(xml|rels)$/i.test(file.name)
    },
  })
  const read = (path: string): Node | undefined => {
    const found = files[path] ?? files[Object.keys(files).find(name => name.toLowerCase() === path.toLowerCase()) ?? '']
    return found ? (parser.parse(strFromU8(found).replace(/^﻿/, '')) as Node) : undefined
  }
  const relationships = (path: string): Map<string, string> => {
    const directory = path.split('/').slice(0, -1).join('/')
    const rels = read(`${directory ? `${directory}/` : ''}_rels/${path.split('/').pop()}.rels`)
    return new Map(
      list(node(rels?.Relationships).Relationship).map(r => [
        String(r['@Id']),
        partPath(path, String(r['@Target'] ?? '')),
      ]),
    )
  }
  const root = list(node(read('_rels/.rels')?.Relationships).Relationship).find(r =>
    String(r['@Type'] ?? '').endsWith('/officeDocument'),
  )
  const workbookPath = root ? partPath('', String(root['@Target'])) : 'xl/workbook.xml'
  const workbook = node(read(workbookPath)?.workbook)
  const sheets = list(node(workbook.sheets).sheet)
  if (sheets.length === 0) throw new Error('no sheets')
  const targets = relationships(workbookPath)
  const from1904 = ['1', 'true'].includes(String(node(workbook.workbookPr)['@date1904'] ?? ''))

  const partOf = (suffix: string) => [...targets.values()].find(path => path.toLowerCase().endsWith(suffix))
  const shared = list(node(read(partOf('sharedstrings.xml') ?? 'xl/sharedStrings.xml')?.sst).si).map(item =>
    // Plain text, or runs of formatted text; phonetic guides (`rPh`) are not what the cell says.
    item.r === undefined
      ? text(item.t)
      : list(item.r)
          .map(run => text(run.t))
          .join(''),
  )
  const styles = node(read(partOf('styles.xml') ?? 'xl/styles.xml')?.styleSheet)
  const custom = new Map(
    list(node(styles.numFmts).numFmt).map(format => [Number(format['@numFmtId']), String(format['@formatCode'] ?? '')]),
  )
  const dated = list(node(styles.cellXfs).xf).map(xf => {
    const id = Number(xf['@numFmtId'] ?? 0)
    return custom.has(id) ? showsDate(custom.get(id)!) : DATE_FORMATS.has(id)
  })

  const valueOf = (cell: Node): Cell => {
    const type = String(cell['@t'] ?? 'n')
    if (type === 'inlineStr') {
      const inline = node(cell.is)
      return inline.r === undefined
        ? text(inline.t)
        : list(inline.r)
            .map(run => text(run.t))
            .join('')
    }
    if (cell.v === undefined) return null
    const raw = text(cell.v)
    if (type === 's') return shared[Number(raw)] ?? ''
    if (type === 'str' || type === 'e') return raw
    if (type === 'b') return raw === '1'
    if (type === 'd') return raw
    if (raw === '') return null
    const number = Number(raw)
    if (!Number.isFinite(number)) return raw
    return dated[Number(cell['@s'] ?? -1)] === true ? serialDate(number, from1904) : number
  }

  const result: Sheet[] = []
  for (const sheet of sheets) {
    // A hidden sheet is the workbook's own bookkeeping, not what the person sent.
    if (['hidden', 'veryHidden'].includes(String(sheet['@state'] ?? ''))) continue
    const path = targets.get(String(sheet['@id'] ?? ''))
    const part = path ? read(path) : undefined
    const rows: { row: number; cells: Cell[] }[] = []
    let columns = 0
    let next = 1
    for (const row of list(node(node(part?.worksheet).sheetData).row)) {
      const number = Number(row['@r'] ?? next)
      next = number + 1
      const cells: Cell[] = []
      let position = 0
      for (const cell of list(row.c)) {
        // A cell says where it is; one that does not follows the one before.
        const column = cell['@r'] === undefined ? position : columnOf(String(cell['@r']))
        position = column + 1
        const value = valueOf(cell)
        if (value === null || value === '') continue
        while (cells.length < column) cells.push(null)
        cells[column] = value
      }
      if (cells.length === 0) continue
      columns = Math.max(columns, cells.length)
      rows.push({ row: number, cells })
    }
    result.push({ name: String(sheet['@name'] ?? `Sheet${result.length + 1}`), rows, columns })
  }
  return result
}
