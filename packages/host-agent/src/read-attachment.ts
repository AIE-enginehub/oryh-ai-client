/**
 * Reading what the person attached in Chat.
 *
 * The Chat agent is given few tools on purpose, and none of them read a file: an attached spreadsheet
 * could be filed with ORYH and not looked at, and where the deployment offers no shell the agent could
 * only say so. This tool reads the file the person chose — by its name or digest, never by a path —
 * and hands back what a model can use: a workbook's sheets a page of rows at a time, or a text file's
 * text. It reads only what is attached to this session, and writes nothing.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { attachedFiles, bytesOf, type ChatFile, type ChatFiles, pickChatFile, textOutput } from '@oryh/dsh-pane'
import { type Cell, readXlsx } from './xlsx.js'

export const READ_TOOL = 'oryh_read_attachment'

/** Offered wherever the agent can read what the person attaches in Chat. */
export const READ_RULE =
  '用户在对话里附上 Excel（.xlsx）、CSV 或文本文件并要你看内容时，用 oryh_read_attachment 按文件名或 sha256 前缀读取：表格先不带 sheet 读一次，看有哪些工作表和各自的行数，再按 sheet、offset 分页读；行多时不要一次读完，先读表头和前几十行弄清结构。读到的是文件原样的内容，据此办理业务仍要按 skill 和写入前确认的规则。旧版 .xls、PDF、Word 和图片这个工具读不了，如实告诉用户，请对方另存为 .xlsx 或 CSV，或者直接说出要办理的内容。'

/** The largest file read: a workbook is parsed whole, in the Host's memory. */
const MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_ROWS = 100
const MAX_ROWS = 200
const MAX_CELL = 500
const TEXT_PAGE = 20_000
/** What one answer may hold, so a wide sheet does not crowd the conversation out. */
const MAX_ANSWER = 40_000
const TEXT_TYPES = new Set(['csv', 'tsv', 'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log'])

const fail = (text: string) => new OryhClientError(text, 'request-failed')
const extensionOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''

const clip = (text: string) => (text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text)

/**
 * A workbook, a page of one sheet at a time.
 * @param data - the file's bytes.
 * @param sheet - the sheet to read rows of; without it, only what sheets there are.
 * @param offset - rows to skip, counting the rows that hold anything.
 * @param limit - rows to return.
 * @returns the sheets and their sizes, and the page asked for.
 */
export async function readWorkbook(
  data: Uint8Array,
  sheet: string | undefined,
  offset: number,
  limit: number,
): Promise<Record<string, unknown>> {
  let book: ReturnType<typeof readXlsx>
  try {
    book = readXlsx(data)
  } catch {
    throw fail('这个文件不是可以读取的 .xlsx 工作簿（可能已损坏、加了密码，或其实是旧版 .xls）。')
  }
  // A sheet with nothing in it — Excel's spare Sheet2 and Sheet3 — is not something to choose between.
  const filled = book.filter(candidate => candidate.rows.length > 0)
  const sheets = (filled.length > 0 ? filled : book).map(candidate => ({
    name: candidate.name,
    rows: candidate.rows.length,
    columns: candidate.columns,
  }))
  // One sheet is the sheet meant; with several the model first sees what there is.
  const name = sheet ?? (sheets.length === 1 ? sheets[0]!.name : undefined)
  if (name === undefined) return { sheets, note: '有多个工作表：用 sheet 指定要读的那一个。' }
  const found = book.find(candidate => candidate.name === name)
  if (!found) throw fail(`没有名为「${name}」的工作表。工作表有：${sheets.map(s => s.name).join('、')}。`)
  const rows: { row: number; cells: Cell[] }[] = []
  let size = 0
  let more = false
  for (const row of found.rows.slice(offset)) {
    if (rows.length >= limit) {
      more = true
      break
    }
    const cells = row.cells.map(cell => (typeof cell === 'string' ? clip(cell) : cell))
    size += JSON.stringify(cells).length
    if (rows.length > 0 && size > MAX_ANSWER) {
      more = true
      break
    }
    rows.push({ row: row.row, cells })
  }
  return {
    sheets,
    sheet: name,
    offset,
    rows,
    // `row` is the row's number in the sheet, as the person sees it; offset counts rows that hold anything.
    ...(more ? { more: true, next_offset: offset + rows.length } : { more: false }),
  }
}

/**
 * The tool, over the Host's stored attachments.
 * @param options.files - where the Host keeps what the person attached.
 */
export function readTool(options: { readonly files: ChatFiles }) {
  return defineTool({
    name: READ_TOOL,
    description:
      '读取用户在本会话里附上的文件的内容：Excel 工作簿（.xlsx）按工作表分页返回行，CSV、TSV、TXT、Markdown、JSON 等文本文件返回文本。' +
      'file 填对话里文件标注的 sha256 前缀或文件名。读表格时不带 sheet 先看有哪些工作表及行数（只有一个工作表时直接返回它的行）；' +
      '带 sheet 读该表的行，offset、limit 分页（limit 最多 200），返回 more 为 true 时用 next_offset 继续。' +
      '每行给出它在表里的行号 row 和各列的值 cells，公式给的是计算结果，日期给 2026-10-20 这样的写法。只读，不修改文件，也不写入 ORYH。' +
      '读不了旧版 .xls、PDF、Word 和图片。',
    parameters: {
      file: { type: 'string', required: true, description: '附件的 sha256 前缀或文件名。' },
      sheet: { type: 'string', description: '要读的工作表名；只对 Excel 有用。' },
      offset: { type: 'integer', description: '跳过的行数（表格）或字符数（文本），默认 0。' },
      limit: { type: 'integer', description: '表格一次返回的行数，默认 100，最多 200。' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      if (!exec.agent) throw fail('需要会话。')
      const attached = attachedFiles(exec.agent.session)
      if (attached.length === 0)
        throw fail('本会话里用户还没有附上文件。请对方在对话框里附上文件（点附件按钮或把文件拖进来）。')
      const file: ChatFile | string = pickChatFile(attached, args.file)
      if (typeof file === 'string') throw fail(file)
      const name = file.ref.name ?? ''
      if (file.kind === 'image') throw fail('这是一张图片，这个工具读不了图片里的内容。请用户说出要办理的内容。')
      const extension = extensionOf(name)
      const offset = Math.max(0, Math.trunc(args.offset ?? 0))
      if (extension !== 'xlsx' && !TEXT_TYPES.has(extension))
        throw fail(
          `这个工具读不了 .${extension || '未知类型'} 文件，只能读 .xlsx 和文本文件（csv、tsv、txt、md、json 等）。请用户另存为 .xlsx 或 CSV 再附上，或者直接说出内容。`,
        )
      if (file.ref.bytes > MAX_BYTES)
        throw fail(`${name} 有 ${(file.ref.bytes / 1024 / 1024).toFixed(1)} MB，超过可读取的 10 MB 上限。`)
      const data = await bytesOf(options.files, file, exec.signal)
      exec.signal.throwIfAborted()
      if (extension === 'xlsx') {
        const limit = Math.min(MAX_ROWS, Math.max(1, Math.trunc(args.limit ?? DEFAULT_ROWS)))
        return JSON.stringify({
          file: name,
          ...(await readWorkbook(data, args.sheet?.trim() || undefined, offset, limit)),
        })
      }
      const text = new TextDecoder('utf-8').decode(data).replace(/^﻿/, '')
      const page = text.slice(offset, offset + TEXT_PAGE)
      const end = offset + page.length
      return JSON.stringify({
        file: name,
        characters: text.length,
        offset,
        text: page,
        ...(end < text.length ? { more: true, next_offset: end } : { more: false }),
      })
    },
  })
}
