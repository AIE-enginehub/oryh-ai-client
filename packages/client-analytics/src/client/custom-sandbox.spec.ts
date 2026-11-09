// @vitest-environment jsdom
import { wordsOf } from '@oryh/ai-client-kit/testing'
import type { CustomPage } from '@oryh/dsh-analytics/types'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { customSrcDoc, frameWords } from './custom-sandbox.js'
import { words } from './words.js'

/** What the frame's script says, in the plugin's own words. */
const frameSays = frameWords(wordsOf(words))

const page = (html: string, fixedText = '') =>
  ({
    id: 'id',
    version: 1,
    updatedAt: '',
    definition: { title: 'test', html, css: 'h1{color:red}', script: '', fixedText, task: {} },
  }) as unknown as CustomPage

/** Run the frame's document as a browser would, hand its bridge the data, and wait for it to render. */
async function rendered(html: string, data: unknown, fixedText = '', forms: Record<string, unknown> = {}) {
  let bridge: MessagePort | undefined
  const heights: number[] = []
  const actions: Record<string, unknown>[] = []
  /** What the bridge last said its forms hold, and whether any holds something typed. */
  const said: { forms: Record<string, unknown>[]; editing: boolean } = { forms: [], editing: false }
  const dom = new JSDOM(customSrcDoc(page(html, fixedText), 'nonce-123', frameSays), {
    runScripts: 'dangerously',
    beforeParse(window) {
      const frame = window as unknown as Record<string, unknown>
      frame.MessageChannel = MessageChannel
      // The frame's parent is where the bridge offers its port; here the frame is its own parent.
      frame.postMessage = (message: { type: string; nonce: string }, _origin: string, ports: MessagePort[]) => {
        expect(message).toEqual({ type: 'oryh-ready', nonce: 'nonce-123' })
        bridge = ports[0]
      }
    },
  })
  expect(bridge).toBeDefined()
  bridge!.onmessage = event => {
    if (event.data.type === 'oryh-height') heights.push(event.data.height)
    if (['oryh-form', 'oryh-open', 'oryh-ask'].includes(event.data.type)) actions.push(event.data)
    if (event.data.type === 'oryh-forms') said.forms = event.data.forms
    if (event.data.type === 'oryh-editing') said.editing = event.data.dirty
  }
  bridge!.postMessage({ type: 'oryh-data', data, forms })
  await settle()
  // The bridge reports its height once it has drawn. On a busy machine that is later than one pause, and a
  // test that read the document before it found an empty page.
  for (const deadline = Date.now() + 2000; heights.length === 0 && Date.now() < deadline; ) await settle()
  return {
    document: dom.window.document,
    heights,
    actions,
    said,
    /** Tell the bridge something, as the host does for Chat: a fill, the marks, a hold. */
    send: async (message: Record<string, unknown>) => {
      bridge!.postMessage(message)
      await settle()
    },
    /** Hand the page new data, as a refresh does. */
    theme: async (css: string) => {
      bridge!.postMessage({ type: 'oryh-theme', css })
      await settle()
    },
    update: async (next: unknown) => {
      bridge!.postMessage({ type: 'oryh-data', data: next, forms })
      await settle()
    },
    /** Answer a submitted form as the host would. */
    answer: async (result: Record<string, unknown>) => {
      bridge!.postMessage({ type: 'oryh-form-result', ...result })
      await settle()
    },
    close: () => bridge!.close(),
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
/** Wait for what the bridge says next: it answers through a timer and a port, later still on a busy machine. */
async function eventually(check: () => void): Promise<void> {
  for (const deadline = Date.now() + 2000; ; ) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await settle()
    }
  }
}

describe('the custom page frame', () => {
  it('spaces date ticks without collisions and preserves every point in a tooltip', async () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ name: `2026-09-${21 + i}`, value: i }))
    const f = await rendered(
      '<div data-oryh-chart="line" data-oryh-data="rows" data-oryh-label="name" data-oryh-value="value"></div>',
      { rows },
    )
    const labels = [...f.document.querySelectorAll('svg text')].filter(t => t.textContent?.startsWith('2026-'))
    let right = -Infinity
    for (const label of labels) {
      const x = Number(label.getAttribute('x'))
      const width = label.textContent!.length * 7.2
      const anchor = label.getAttribute('text-anchor')
      const left = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2
      expect(left).toBeGreaterThanOrEqual(right + 16)
      right = left + width
    }
    expect(labels[0]?.textContent).toBe(rows[0]!.name)
    expect(labels.at(-1)?.textContent).toBe(rows.at(-1)!.name)
    expect(f.document.querySelectorAll('svg circle title')).toHaveLength(13)
    f.close()
  })
  it('reserves room for long business labels and keeps endpoint dates inside the chart', async () => {
    const f = await rendered(
      '<div data-oryh-chart="bar" data-oryh-data="rows" data-oryh-label="name" data-oryh-value="value"></div><div data-oryh-chart="line" data-oryh-data="rows" data-oryh-label="name" data-oryh-value="value"></div>',
      {
        rows: [
          { name: 'Factory condition monitoring pilot', value: 160 },
          { name: 'Laboratory measurement upgrade', value: 154 },
        ],
      },
    )
    const charts = f.document.querySelectorAll('svg')
    const label = charts[0]!.querySelector('text')!
    expect(Number(label.getAttribute('x'))).toBeGreaterThan(200)
    expect(label.querySelector('title')?.textContent).toBe('Factory condition monitoring pilot')
    const dates = [...charts[1]!.querySelectorAll('text')].filter(t => t.textContent?.includes('upgrade'))
    expect(dates[0]?.getAttribute('text-anchor')).toBe('end')
    f.close()
  })
  it('keeps arbitrary layout but removes executable nodes and uses a nonce-only bridge', () => {
    const doc = customSrcDoc(
      page(
        '<main><h1 data-oryh-field="total">—</h1><script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="https://evil.test" onclick="alert(1)">link</a><template data-oryh-each="rows"><p data-oryh-field="name"></p><meta http-equiv="refresh" content="0;url=https://evil.test"><script>alert(3)</script></template><div></div><svg><script>alert(4)</script></svg></main>',
        '</script><script>alert(2)</script>',
      ),
      'nonce-123',
      frameSays,
    )
    expect(doc).toContain('data-oryh-field="total"')
    expect(doc).toContain('template data-oryh-each="rows"')
    expect(doc).not.toContain('<iframe')
    expect(doc).not.toContain('onclick=')
    expect(doc).not.toContain('href="https://evil.test"')
    expect(doc).not.toContain('alert(1)')
    expect(doc).not.toContain('alert(3)')
    expect(doc).not.toContain('alert(4)')
    expect(doc).not.toContain('http-equiv="refresh"')
    expect(doc).not.toContain('</script><script>alert(2)')
    expect(doc).toContain("script-src 'nonce-nonce-123'")
    expect(doc).toContain('new MessageChannel()')
  })

  it.each(['plaintext', 'xmp', 'noscript', 'noembed', 'noframes', 'title'])(
    'removes reparsing-sensitive %s markup without swallowing the bridge',
    tag => {
      const doc = customSrcDoc(page(`<main><${tag}>untrusted</${tag}></main>`), 'n', frameSays)
      const parsed = new DOMParser().parseFromString(doc, 'text/html')
      expect(parsed.querySelector(tag)).toBeNull()
      expect(parsed.querySelector('script[nonce="n"]')).not.toBeNull()
    },
  )

  it('updates appearance through the port without replacing typed form elements', async () => {
    const f = await rendered('<form data-oryh-form="note"><input name="text"></form>', {}, '', {
      note: {
        name: 'note',
        label: 'Note',
        instruction: 'Save',
        fields: [{ name: 'text', label: 'Text', type: 'text' }],
      },
    })
    try {
      const input = f.document.querySelector('input')!
      input.value = 'Keep my input'
      await f.theme(':root{color-scheme:dark;--text:white}')
      expect(f.document.querySelector('input')).toBe(input)
      expect(input.value).toBe('Keep my input')
      expect(f.document.getElementById('oryh-theme')?.textContent).toContain('color-scheme:dark')
    } finally {
      f.close()
    }
  })

  it('takes new words over the port without rebuilding the frame', async () => {
    const f = await rendered(
      '<div data-oryh-chart="bar" data-oryh-data="rows" data-oryh-label="x" data-oryh-value="y"></div>',
      [],
    )
    try {
      expect(f.document.body.textContent).toContain(frameSays.chartEmpty)
      await f.send({ type: 'oryh-words', words: { ...frameSays, chartEmpty: 'Nothing yet' } })
      await f.send({ type: 'oryh-data', data: [], forms: {} })
      expect(f.document.body.textContent).toContain('Nothing yet')
    } finally {
      f.close()
    }
  })

  it("takes the workbench's theme, and lets no value break out of its stylesheet", () => {
    const doc = customSrcDoc(page('<h1>x</h1>'), 'n', frameSays, {
      scheme: 'dark',
      tokens: { text: '#e1e7ee', accent: '#86c9bb', line: 'red;}</style><script>alert(1)</script>' },
      font: 'Inter, "PingFang SC", sans-serif',
    })
    expect(doc).toContain('color-scheme:dark;--text:#e1e7ee;--accent:#86c9bb')
    expect(doc).not.toContain('--line:')
    expect(doc).not.toContain('alert(1)')
    expect(doc).toContain('font-family:Inter, "PingFang SC", sans-serif')
    // The theme comes first, so the page's own CSS is laid over it.
    expect(doc.indexOf('color-scheme')).toBeLessThan(doc.lastIndexOf('<style>'))
    expect(customSrcDoc(page('<h1>x</h1>'), 'n', frameSays)).toContain('color-scheme:light')
  })

  it("keeps a page's layout but not colors, backgrounds or fonts of its own", () => {
    const styled = {
      ...page('<main></main>'),
      definition: {
        ...page('').definition,
        css: 'main{padding:20px;background:#fff;color:#000}table{width:100%;font-family:Arial}.hot{color:var(--accent);background-color:white}',
      },
    } as CustomPage
    const doc = customSrcDoc(styled, 'n', frameSays)
    const own = doc.slice(doc.lastIndexOf('<style>'), doc.lastIndexOf('</style>'))
    expect(own).toContain('padding:20px')
    expect(own).toContain('width:100%')
    expect(own).toContain('color:var(--accent)')
    expect(own).not.toMatch(/#fff|#000|Arial|white/)
  })

  it('fills each repeated row from its own item, not from the page data around it', async () => {
    const frame = await rendered(
      '<h1 data-oryh-field="title"></h1><table><thead><tr><th>客户</th><th>金额</th></tr></thead><template data-oryh-each="rows"><tr><td data-oryh-field="name"></td><td data-oryh-field="amount" data-oryh-format="money"></td></tr></template><tbody></tbody></table><ul><template data-oryh-each="groups"><li><b data-oryh-field="name"></b><template data-oryh-each="items"><i data-oryh-field="name"></i></template><span></span></li></template><div></div></ul><p data-oryh-fixed></p>',
      {
        title: '订单统计',
        name: '顶层不该出现在行里',
        rows: [
          { name: '甲', amount: '1234.5' },
          { name: '乙', amount: 7 },
        ],
        groups: [{ name: 'A', items: [{ name: 'a1' }, { name: 'a2' }] }],
      },
      '口径说明',
    )
    const { document, heights } = frame
    expect(document.querySelector('h1')!.textContent).toBe('订单统计')
    // The element after a template holds its copies: in a table, the tbody after the row template.
    const cells = [...document.querySelectorAll('tbody td')].map(td => td.textContent)
    expect(cells).toEqual(['甲', '1,234.50', '乙', '7.00'])
    expect([...document.querySelectorAll('li i')].map(i => i.textContent)).toEqual(['a1', 'a2'])
    expect(document.querySelector('li b')!.textContent).toBe('A')
    expect(document.querySelector('[data-oryh-fixed]')!.textContent).toBe('口径说明')
    expect(heights.length).toBeGreaterThan(0)
    frame.close()
  })

  it('draws charts from an array, and sorts a table by the column clicked', async () => {
    const { document, close } = await rendered(
      '<div id="bar" data-oryh-chart="bar" data-oryh-data="rows" data-oryh-label="name" data-oryh-value="amount"></div><div id="pie" data-oryh-chart="pie" data-oryh-data="rows" data-oryh-label="name" data-oryh-value="amount"></div><div id="line" data-oryh-chart="line" data-oryh-data="rows" data-oryh-label="name" data-oryh-value="amount"></div><div id="none" data-oryh-chart="bar" data-oryh-data="missing" data-oryh-label="name" data-oryh-value="amount"></div><table data-oryh-sortable><thead><tr><th>客户</th><th>金额</th></tr></thead><tbody><tr><td>乙</td><td>20</td></tr><tr><td>甲</td><td>3</td></tr><tr><td>丙</td><td>100</td></tr></tbody></table>',
      {
        rows: [
          { name: '甲', amount: 30 },
          { name: '乙', amount: '10' },
        ],
      },
    )
    expect(document.querySelectorAll('#bar svg rect')).toHaveLength(2)
    expect(document.querySelector('#bar')!.textContent).toContain('甲')
    expect(document.querySelectorAll('#pie svg path')).toHaveLength(2)
    expect(document.querySelector('#pie')!.textContent).toContain('75.0%')
    expect(document.querySelector('#line svg polyline')).not.toBeNull()
    expect(document.querySelector('#none')!.textContent).toBe('没有可绘制的数据')
    const amount = document.querySelectorAll('th')[1]!
    amount.dispatchEvent(new document.defaultView!.MouseEvent('click'))
    const order = () => [...document.querySelectorAll('tbody tr')].map(tr => tr.firstElementChild!.textContent)
    expect(order()).toEqual(['甲', '乙', '丙'])
    amount.dispatchEvent(new document.defaultView!.MouseEvent('click'))
    expect(order()).toEqual(['丙', '乙', '甲'])
    expect(amount.getAttribute('aria-sort')).toBe('descending')
    close()
  })

  it('draws one mark per label, summing rows that share it and leaving out rows with no number', async () => {
    const { document, close } = await rendered(
      '<div id="bar" data-oryh-chart="bar" data-oryh-data="orders" data-oryh-label="customer" data-oryh-value="amount"></div>',
      {
        orders: [
          { customer: '仁济医院', amount: '243,200' },
          { customer: '泰安市中心医院', amount: 84480 },
          // No amount yet: not a bar of zero, and not a second bar for a customer who has one.
          { customer: '仁济医院', amount: null },
          { customer: '市第一人民医院', amount: '' },
          { customer: '仁济医院', amount: '800' },
        ],
      },
    )
    const bar = document.querySelector('#bar')!
    expect(bar.querySelectorAll('svg rect')).toHaveLength(2)
    expect(bar.textContent).toContain('244,000')
    expect(bar.textContent).not.toContain('市第一人民医院')
    close()
  })

  it('keeps only a declared form, and never lets it submit anywhere itself', () => {
    const doc = customSrcDoc(
      page(
        '<form action="https://evil.test" method="post" target="_top"><input name="a"></form><form data-oryh-form="followUp" action="https://evil.test" target="_blank" enctype="text/plain"><button formaction="https://evil.test" formtarget="_top">送出</button></form>',
      ),
      'n',
      frameSays,
    )
    expect(doc).not.toContain('evil.test')
    expect(doc).not.toContain('target=')
    expect(doc).not.toContain('<input name="a">')
    expect(doc).toContain('<form data-oryh-form="followUp">')
    expect(doc).toContain("form-action 'none'")
  })

  it("hands a row's form to the host with its row and declared values, and shows what the host answered", async () => {
    const frame = await rendered(
      '<table><template data-oryh-each="rows"><tr><td data-oryh-field="customer"></td><td><form data-oryh-form="followUp"><textarea name="note"></textarea><select name="level"></select><input name="stray" value="x"><button type="submit">登记</button></form></td></tr></template><tbody></tbody></table><form data-oryh-form="note"><input name="text" value="页面级"><button type="submit">记</button></form><form data-oryh-form="unknown"><button type="submit">?</button></form>',
      { rows: [{ customer: '甲' }, { customer: '乙' }] },
      '',
      {
        followUp: {
          fields: [
            { name: 'note', label: '说明', type: 'textarea', required: true },
            { name: 'level', label: '级别', type: 'select', required: true, options: ['高', '普通'] },
          ],
        },
        note: { fields: [{ name: 'text', label: '内容', type: 'text', required: true }] },
      },
    )
    const { document } = frame
    const forms = document.querySelectorAll<HTMLFormElement>('tbody form')
    expect([...forms].map(form => form.getAttribute('data-oryh-row'))).toEqual(['rows.0', 'rows.1'])
    // The select's choices come from the definition, with nothing chosen yet.
    expect([...forms[1]!.querySelector('select')!.options].map(option => option.textContent)).toEqual([
      '请选择',
      '高',
      '普通',
    ])
    forms[1]!.querySelector('textarea')!.value = '下周送货'
    forms[1]!.querySelector('select')!.value = '普通'
    forms[1]!.requestSubmit()
    await settle()
    // Only what the definition declares leaves the frame.
    expect(frame.actions).toEqual([
      { type: 'oryh-form', request: 1, form: 'followUp', row: 'rows.1', values: { note: '下周送货', level: '普通' } },
    ])
    // While the host asks the person, the form cannot be sent again.
    expect(forms[1]!.querySelector('button')!.disabled).toBe(true)
    forms[1]!.requestSubmit()
    await settle()
    expect(frame.actions).toHaveLength(1)
    await frame.answer({ request: 1, ok: true, message: '已交给 Agent。' })
    expect(forms[1]!.querySelector('.oryh-form-status')!.textContent).toBe('已交给 Agent。')
    expect(forms[1]!.querySelector('textarea')!.value).toBe('')
    expect(forms[1]!.querySelector('button')!.disabled).toBe(false)
    // A form outside any repeated row belongs to the page as a whole.
    document.querySelector<HTMLFormElement>('form[data-oryh-form="note"]')!.requestSubmit()
    await settle()
    expect(frame.actions[1]).toMatchObject({ form: 'note', row: '', values: { text: '页面级' } })
    await frame.answer({ request: 2, ok: false, cancelled: true, message: '已取消。' })
    const status = document.querySelector('form[data-oryh-form="note"] .oryh-form-status')!
    expect(status.getAttribute('data-kind')).toBe('muted')
    // A form the definition does not declare sends nothing.
    document.querySelector<HTMLFormElement>('form[data-oryh-form="unknown"]')!.requestSubmit()
    await settle()
    expect(frame.actions).toHaveLength(2)
    frame.close()
  })
  it('tells the host what each form holds, takes what Chat fills, marks it, and holds the form meanwhile', async () => {
    const frame = await rendered(
      '<form data-oryh-form="order"><input name="note"><input type="checkbox" name="urgent"><fieldset data-oryh-lines="items"><template><div><select name="product"></select><input name="quantity"><input name="price"></div></template><div></div></fieldset><output name="total"></output><button type="submit">提交</button></form>',
      { products: [{ id: 'p1', name: 'JC-800', price: '100' }] },
      '',
      {
        order: {
          fields: [
            { name: 'note', label: '说明', type: 'text' },
            { name: 'urgent', label: '加急', type: 'checkbox' },
            {
              name: 'items',
              label: '明细',
              type: 'lines',
              min: 1,
              fields: [
                {
                  name: 'product',
                  label: '产品',
                  type: 'select',
                  source: { data: 'products', value: 'id', label: 'name' },
                },
                { name: 'quantity', label: '数量', type: 'number' },
                { name: 'price', label: '单价', type: 'number' },
              ],
              computed: [{ name: 'amount', label: '金额', multiply: ['quantity', 'price'] }],
            },
          ],
          computed: [{ name: 'total', label: '合计', sum: 'items.amount' }],
        },
      },
    )
    const { document } = frame
    const blank = { product: '', quantity: '', price: '' }
    await eventually(() =>
      expect(frame.said.forms).toEqual([
        { id: 'order', name: 'order', row: '', busy: false, values: { note: '', urgent: false, items: [blank] } },
      ]),
    )
    // What the person types reaches the host as they type it.
    const note = document.querySelector<HTMLInputElement>('input[name=note]')!
    note.value = '老客户'
    note.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }))
    await eventually(() => expect(frame.said.forms[0]).toMatchObject({ values: { note: '老客户' } }))
    // Chat fills the tick and two lines; the note it was not given stays as typed.
    await frame.send({
      type: 'oryh-form-fill',
      form: 'order',
      values: {
        urgent: true,
        items: [
          { product: 'p1', quantity: '2', price: '100' },
          { product: 'p1', quantity: '1', price: '90' },
        ],
      },
    })
    await eventually(() =>
      expect(frame.said.forms[0]).toMatchObject({
        values: {
          note: '老客户',
          urgent: true,
          items: [
            { product: 'p1', quantity: '2', price: '100' },
            { product: 'p1', quantity: '1', price: '90' },
          ],
        },
      }),
    )
    expect(document.querySelector('output[name=total]')!.textContent).toBe('290')
    await frame.send({ type: 'oryh-form-marks', form: 'order', marks: ['urgent', 'items.0.quantity', 'items.1'] })
    const marked = [...document.querySelectorAll('[data-ai-filled]')]
    expect(marked.map(element => element.getAttribute('name') ?? element.tagName)).toEqual([
      'urgent',
      'quantity',
      'DIV',
    ])
    // Held while Chat is still at it: a submit sends nothing, and says why.
    await frame.send({ type: 'oryh-form-hold', form: 'order', on: true })
    document.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle()
    expect(frame.actions).toHaveLength(0)
    expect(document.querySelector('.oryh-form-status')!.textContent).toContain('AI 助手还在处理')
    await frame.send({ type: 'oryh-form-hold', form: 'order', on: false })
    document.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle()
    expect(frame.actions).toHaveLength(1)
    // Taking the fill back to what the form first held leaves nothing to protect.
    await frame.answer({ request: 1, ok: false, cancelled: true, message: '已取消。' })
    await frame.send({ type: 'oryh-form-marks', form: 'order', marks: [] })
    await frame.send({ type: 'oryh-form-fill', form: 'order', values: { note: '', urgent: false, items: [blank] } })
    expect(document.querySelector('[data-ai-filled]')).toBeNull()
    await eventually(() => {
      expect(frame.said.editing).toBe(false)
      expect(frame.said.forms[0]).toMatchObject({ values: { note: '', urgent: false, items: [blank] } })
    })
    frame.close()
  })
  it('lets the person add lines, choose from the page data, and see figures as they type', async () => {
    const frame = await rendered(
      '<form data-oryh-form="order"><input data-oryh-options-filter="product"><fieldset data-oryh-lines="items"><template><div><select name="product" required></select><input name="quantity" required><input name="price"><input type="checkbox" name="gift"><output name="amount"></output><button type="button" data-oryh-line-remove>删</button></div></template><div></div><button type="button" data-oryh-line-add>加一行</button></fieldset><output name="total"></output><button type="submit">提交</button></form>',
      {
        products: [
          { id: 'p1', name: 'JC-800', price: '121600' },
          { id: 'p2', name: '色带', price: '335' },
        ],
      },
      '',
      {
        order: {
          fields: [
            {
              name: 'items',
              label: '明细',
              type: 'lines',
              required: true,
              min: 1,
              max: 2,
              fields: [
                {
                  name: 'product',
                  label: '产品',
                  type: 'select',
                  required: true,
                  source: { data: 'products', value: 'id', label: 'name' },
                  defaults: { price: 'price' },
                },
                { name: 'quantity', label: '数量', type: 'number', required: true },
                { name: 'price', label: '单价', type: 'number', required: true },
                { name: 'gift', label: '赠品', type: 'checkbox', required: false },
              ],
              computed: [{ name: 'amount', label: '金额', multiply: ['quantity', 'price'], zeroWhen: 'gift' }],
            },
          ],
          computed: [{ name: 'total', label: '合计', sum: 'items.amount' }],
        },
      },
    )
    const { document } = frame
    const window = document.defaultView!
    const lines = () => [...document.querySelectorAll<HTMLElement>('[data-oryh-line]')]
    const fire = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true }))
    expect(lines()).toHaveLength(1)
    const [first] = lines()
    const product = first!.querySelector('select')!
    expect([...product.options].map(option => option.textContent)).toEqual(['请选择', 'JC-800', '色带'])
    // An empty line is the host's to drop, so the browser's own checks do not hold the form back over it.
    expect(first!.querySelectorAll('[required]')).toHaveLength(0)
    // Choosing a product fills its price in as a default; the person may still change it.
    product.value = 'p1'
    fire(product, 'change')
    expect(first!.querySelector<HTMLInputElement>('[name=price]')!.value).toBe('121600')
    first!.querySelector<HTMLInputElement>('[name=quantity]')!.value = '2'
    fire(first!.querySelector('[name=quantity]')!, 'input')
    expect(first!.querySelector('output')!.textContent).toBe('243,200')
    // At most max lines; a gift line counts nothing.
    const add = document.querySelector<HTMLButtonElement>('[data-oryh-line-add]')!
    add.click()
    add.click()
    expect(lines()).toHaveLength(2)
    const second = lines()[1]!
    second.querySelector('select')!.value = 'p2'
    fire(second.querySelector('select')!, 'change')
    second.querySelector<HTMLInputElement>('[name=quantity]')!.value = '10'
    second.querySelector<HTMLInputElement>('[name=gift]')!.checked = true
    fire(second.querySelector('[name=gift]')!, 'change')
    expect(second.querySelector('output')!.textContent).toBe('0')
    expect(document.querySelector('form > output[name=total]')!.textContent).toBe('243,200')
    // Typing in the options filter narrows the choices, never the one already chosen.
    const filter = document.querySelector<HTMLInputElement>('[data-oryh-options-filter]')!
    filter.value = 'JC'
    fire(filter, 'input')
    expect([...product.options].filter(option => !option.hidden).map(option => option.value)).toEqual(['', 'p1'])
    const chosen = second.querySelector('select')!
    expect([...chosen.options].filter(option => !option.hidden).map(option => option.value)).toEqual(['', 'p1', 'p2'])
    document.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle()
    expect(frame.actions[0]).toMatchObject({
      form: 'order',
      values: {
        items: [
          { product: 'p1', quantity: '2', price: '121600', gift: false },
          { product: 'p2', quantity: '10', price: '335', gift: true },
        ],
      },
    })
    // Removing stops at the least the definition allows; a sent form starts over from its least.
    await frame.answer({ request: 1, ok: true, message: '已交给 Agent。' })
    expect(lines()).toHaveLength(1)
    lines()[0]!.querySelector<HTMLButtonElement>('[data-oryh-line-remove]')!.click()
    expect(lines()).toHaveLength(1)
    frame.close()
  })
  it('narrows rows and their chart as the person types, keeping each row’s own index', async () => {
    const frame = await rendered(
      '<input data-oryh-filter="rows" data-oryh-filter-field="customer"><select data-oryh-filter="rows" data-oryh-filter-field="level"><option value="">全部</option><option>高</option></select><div data-oryh-chart="bar" data-oryh-data="rows" data-oryh-label="customer" data-oryh-value="amount"></div><table><template data-oryh-each="rows"><tr><td data-oryh-field="customer"></td><td><form data-oryh-form="followUp"><button type="submit">跟进</button></form></td></tr></template><tbody></tbody></table>',
      {
        rows: [
          { customer: '仁济医院', level: '高', amount: 3 },
          { customer: '市一医院', level: '普通', amount: 2 },
          { customer: '仁和诊所', level: '普通', amount: 1 },
        ],
      },
    )
    const { document } = frame
    const window = document.defaultView!
    const shown = () => [...document.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent)
    const input = document.querySelector<HTMLInputElement>('input[data-oryh-filter]')!
    input.value = '仁'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect(shown()).toEqual(['仁济医院', '仁和诊所'])
    expect(document.querySelectorAll('[data-oryh-chart] svg rect')).toHaveLength(2)
    // The rows shown still name their place in the data, so a form acts on the right row.
    expect([...document.querySelectorAll('tbody form')].map(form => form.getAttribute('data-oryh-row'))).toEqual([
      'rows.0',
      'rows.2',
    ])
    const select = document.querySelector<HTMLSelectElement>('select[data-oryh-filter]')!
    select.value = '高'
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    expect(shown()).toEqual(['仁济医院'])
    input.value = ''
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    select.value = ''
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    expect(shown()).toHaveLength(3)
    frame.close()
  })

  it('fills a container that holds only its template, and lists the choices of a select left without any', async () => {
    const customers = [
      { id: 'c1', name: '仁济医院', currency: 'CNY' },
      { id: 'c2', name: 'Acme', currency: 'USD' },
      { id: 'c3', name: '市一医院', currency: 'CNY' },
    ]
    const frame = await rendered(
      '<select data-oryh-filter="customers" data-oryh-filter-field="currency"></select><div class="cards"><template data-oryh-each="customers"><article data-oryh-open="customer:id"><b data-oryh-field="name"></b></article></template></div>',
      { customers },
    )
    const { document } = frame
    const window = document.defaultView!
    const cards = () => [...document.querySelectorAll('.cards article')].map(card => card.textContent)
    expect(cards()).toEqual(['仁济医院', 'Acme', '市一医院'])
    // The copies are the cards themselves, each naming its row, with the template still first.
    expect(document.querySelector('.cards')!.firstElementChild!.tagName).toBe('TEMPLATE')
    expect([...document.querySelectorAll('.cards article')].map(card => card.getAttribute('data-oryh-row'))).toEqual([
      'customers.0',
      'customers.1',
      'customers.2',
    ])
    const select = document.querySelector<HTMLSelectElement>('select[data-oryh-filter]')!
    expect([...select.options].map(option => [option.value, option.textContent])).toEqual([
      ['', '全部'],
      ['CNY', 'CNY'],
      ['USD', 'USD'],
    ])
    // Drawn again, the old copies go: nothing is shown twice.
    select.value = 'USD'
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    expect(cards()).toEqual(['Acme'])
    await frame.update({ customers: customers.slice(0, 2).concat({ id: 'c4', name: '华东体检', currency: 'EUR' }) })
    expect([...select.options].map(option => option.value)).toEqual(['', 'CNY', 'EUR', 'USD'])
    expect(select.value).toBe('USD')
    expect(cards()).toEqual(['Acme'])
    // A choice the new data no longer has goes back to all.
    await frame.update({ customers: [customers[0]] })
    expect(select.value).toBe('')
    expect(cards()).toEqual(['仁济医院'])
    frame.close()
  })

  it('narrows several arrays from one input when the filter names them all', async () => {
    const frame = await rendered(
      '<input data-oryh-filter="rows,orders" data-oryh-filter-field="customer"><table id="a"><template data-oryh-each="rows"><tr><td data-oryh-field="customer"></td></tr></template><tbody></tbody></table><table id="b"><template data-oryh-each="orders"><tr><td data-oryh-field="orderNo"></td></tr></template><tbody></tbody></table>',
      {
        rows: [{ customer: '仁济医院' }, { customer: '市一医院' }],
        orders: [
          { customer: '仁济医院', orderNo: 'E2E-001' },
          { customer: '市一医院', orderNo: 'SO1' },
          { customer: '仁济医院', orderNo: 'E2E-002' },
        ],
      },
    )
    const { document } = frame
    const window = document.defaultView!
    const shown = (table: string) => [...document.querySelectorAll(`#${table} tbody td`)].map(td => td.textContent)
    const input = document.querySelector<HTMLInputElement>('input[data-oryh-filter]')!
    input.value = '仁济'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect(shown('a')).toEqual(['仁济医院'])
    expect(shown('b')).toEqual(['E2E-001', 'E2E-002'])
    frame.close()
  })

  it('asks the host to open a row’s record or ask Chat about it, naming only the row', async () => {
    const frame = await rendered(
      '<table><template data-oryh-each="rows"><tr><td data-oryh-open="sales_order:id" data-oryh-field="orderNo"></td><td><button data-oryh-ask="这一单为什么有风险">问一下</button></td></tr></template><tbody></tbody></table><button data-oryh-ask="总体怎么样">问总体</button>',
      {
        rows: [
          { id: 'o1', orderNo: 'SO1' },
          { id: 'o2', orderNo: 'SO2' },
        ],
      },
    )
    const { document } = frame
    const window = document.defaultView!
    document
      .querySelectorAll<HTMLElement>('[data-oryh-open]')[1]!
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    document
      .querySelectorAll<HTMLElement>('tbody [data-oryh-ask]')[0]!
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    document
      .querySelector<HTMLElement>('body > [data-oryh-ask]')!
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    expect(frame.actions).toEqual([
      { type: 'oryh-open', target: 'sales_order:id', row: 'rows.1' },
      { type: 'oryh-ask', question: '这一单为什么有风险', row: 'rows.0' },
      { type: 'oryh-ask', question: '总体怎么样', row: '' },
    ])
    frame.close()
  })
})
