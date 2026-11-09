import ExcelJS from 'exceljs'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { READ_TOOL, readTool, readWorkbook } from '../src/read-attachment.js'
import { readXlsx } from '../src/xlsx.js'

async function workbook(): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook()
  const orders = book.addWorksheet('订单')
  orders.addRow(['客户', '数量', '交期', '金额'])
  orders.addRow(['仁济医院', 2, new Date('2026-10-20T00:00:00Z'), { formula: 'B2*100', result: 200 }])
  orders.addRow([])
  orders.addRow(['华东体检', 5, null, { richText: [{ text: '待' }, { text: '定' }] }])
  for (let n = 0; n < 6; n++) orders.addRow([`客户${n}`, n])
  book.addWorksheet('说明').addRow(['仅供测试'])
  return new Uint8Array(await book.xlsx.writeBuffer())
}

const file = (name: string, data: Uint8Array) => {
  const ref = { attachmentId: `sha256:${'ab'.repeat(32)}`, name, bytes: data.byteLength }
  return {
    exec: {
      agent: {
        id: 's',
        session: {
          deriveMessages: () => [
            { role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] },
          ],
        },
      },
      signal: new AbortController().signal,
    } as never,
    files: {
      readImage: async () => ({ data }),
      async *readFileStream() {
        yield data
      },
    },
  }
}

describe('reading what the person attached', () => {
  it('reads a workbook written with namespace prefixes and targets from the package root', () => {
    // What a shop platform's export looks like: valid, and nothing like what Excel itself writes.
    const main = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    const rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    const rels = (items: string) =>
      strToU8(
        `\uFEFF<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`,
      )
    const data = zipSync({
      '_rels/.rels': rels('<Relationship Type="http://x/officeDocument" Target="/xl/workbook.xml" Id="R1" />'),
      'xl/workbook.xml': strToU8(
        `<x:workbook ${main}><x:sheets><x:sheet name="Sheet1" sheetId="1" r:id="Ra" ${rel} /><x:sheet name="Sheet2" sheetId="2" r:id="Rb" ${rel} /></x:sheets></x:workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': rels(
        '<Relationship Type="http://x/worksheet" Target="/xl/worksheets/sheet1.xml" Id="Ra" /><Relationship Type="http://x/worksheet" Target="/xl/worksheets/sheet2.xml" Id="Rb" /><Relationship Type="http://x/styles" Target="/xl/styles.xml" Id="Rs" /><Relationship Type="http://x/sharedStrings" Target="/xl/sharedStrings.xml" Id="Rt" />',
      ),
      'xl/styles.xml': strToU8(
        `<x:styleSheet ${main}><x:numFmts count="1"><x:numFmt numFmtId="176" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;" /></x:numFmts><x:cellXfs><x:xf numFmtId="0" /><x:xf numFmtId="176" /><x:xf numFmtId="14" /></x:cellXfs></x:styleSheet>`,
      ),
      'xl/sharedStrings.xml': strToU8(`<x:sst ${main}><x:si><x:t>共享</x:t></x:si></x:sst>`),
      'xl/worksheets/sheet1.xml': strToU8(
        `<x:worksheet ${main}><x:sheetData>` +
          '<x:row r="1"><x:c r="A1" t="str"><x:v>订单号</x:v></x:c><x:c r="C1" t="str"><x:v>下单日期</x:v></x:c></x:row>' +
          '<x:row r="2"><x:c r="A2" t="str"><x:v>007</x:v></x:c><x:c r="B2" t="s"><x:v>0</x:v></x:c><x:c r="C2" s="1"><x:v>46315</x:v></x:c><x:c r="D2"><x:v>12.5</x:v></x:c><x:c r="E2" t="inlineStr"><x:is><x:t> 留空格 </x:t></x:is></x:c></x:row>' +
          '<x:row r="3"><x:c r="A3" s="2" /></x:row>' +
          '</x:sheetData></x:worksheet>',
      ),
      'xl/worksheets/sheet2.xml': strToU8(`<x:worksheet ${main}><x:sheetData /></x:worksheet>`),
    })
    const [first, second] = readXlsx(data)
    expect(first).toEqual({
      name: 'Sheet1',
      columns: 5,
      rows: [
        { row: 1, cells: ['订单号', null, '下单日期'] },
        // A number written as text keeps its zeros; a number formatted as a date is read as the date.
        { row: 2, cells: ['007', '共享', '2026-10-20', 12.5, ' 留空格 '] },
      ],
    })
    expect(second).toEqual({ name: 'Sheet2', columns: 0, rows: [] })
    expect(() => readXlsx(strToU8('not a zip'))).toThrow()
  })

  it('says what sheets a workbook has, then gives one a page of rows at a time', async () => {
    const data = await workbook()
    const first = await readWorkbook(data, undefined, 0, 100)
    expect(first.sheets).toEqual([
      { name: '订单', rows: 9, columns: 4 },
      { name: '说明', rows: 1, columns: 1 },
    ])
    expect(first.rows).toBeUndefined()
    const page = (await readWorkbook(data, '订单', 0, 3)) as { rows: unknown[]; more: boolean; next_offset: number }
    // The empty third row is passed over, and each row keeps its number in the sheet.
    expect(page.rows).toEqual([
      { row: 1, cells: ['客户', '数量', '交期', '金额'] },
      { row: 2, cells: ['仁济医院', 2, '2026-10-20', 200] },
      { row: 4, cells: ['华东体检', 5, null, '待定'] },
    ])
    expect(page).toMatchObject({ more: true, next_offset: 3 })
    const rest = (await readWorkbook(data, '订单', 3, 100)) as { rows: { row: number }[]; more: boolean }
    expect(rest.rows.map(r => r.row)).toEqual([5, 6, 7, 8, 9, 10])
    expect(rest.more).toBe(false)
    await expect(readWorkbook(data, '没有', 0, 10)).rejects.toThrow('没有名为「没有」的工作表')
    await expect(readWorkbook(new TextEncoder().encode('not a zip'), undefined, 0, 10)).rejects.toThrow('不是可以读取')
  })

  it('reads the file the person attached by its name, and says what it cannot read', async () => {
    const sheet = file('订单导入.xlsx', await workbook())
    const tool = readTool({ files: sheet.files })
    expect(tool.name).toBe(READ_TOOL)
    const listed = JSON.parse(await tool.execute({ file: '订单导入.xlsx' }, sheet.exec))
    expect(listed.sheets).toHaveLength(2)
    const read = JSON.parse(await tool.execute({ file: 'sha256:abababab', sheet: '说明' }, sheet.exec))
    expect(read.rows).toEqual([{ row: 1, cells: ['仅供测试'] }])
    await expect(tool.execute({ file: '别的.xlsx' }, sheet.exec)).rejects.toThrow('没有找到')

    const csv = file('客户.csv', new TextEncoder().encode('﻿编码,名称\nH-001,市第一人民医院\n'))
    const text = JSON.parse(await readTool({ files: csv.files }).execute({ file: '客户.csv' }, csv.exec))
    expect(text).toMatchObject({ text: '编码,名称\nH-001,市第一人民医院\n', more: false })

    const old = file('旧表.xls', new Uint8Array(8))
    await expect(readTool({ files: old.files }).execute({ file: '旧表.xls' }, old.exec)).rejects.toThrow('读不了 .xls')
  })
})
