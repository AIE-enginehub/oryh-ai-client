import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import { jsonPromptText, plainPromptText } from '../src/prompt-text.js'

/** What a to-do title, an expense note or a tenant name could hold and end the session with. */
const BRACES = ['{{x}}', '{{', '}}', '{{}}', '{{{', '{{{{', 'a {{ b }} c', '{{ 参数 }}', '}}{{']

/** Assemble one context through the real system prompt, and hand back what it rendered. */
async function rendered(text: string): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  ctx.systemPrompt.context({ name: 'oryh-current-page', order: 10000, text: () => text })
  const sections = renderContextSections(await ctx.systemPrompt.assemble())
  const section = sections.find(one => one.name === 'oryh-current-page')
  if (!section) throw new Error('the context did not reach the assembly')
  return section.text
}

describe('ORYH data on its way into the prompt', () => {
  it('assembles a page whose data carries braces, and reads back as it was written', async () => {
    const page = { list: 'todos', rows: BRACES.map((title, id) => ({ id, title })), note: '结算 {{金额}}' }
    expect(JSON.parse(await rendered(jsonPromptText(page)))).toEqual(page)
  })

  it('is what keeps that page from ending the session', async () => {
    // Without the escape the assembler throws, and a session whose prompt cannot be built cannot answer.
    await expect(rendered(JSON.stringify({ title: '{{x}}' }))).rejects.toThrow(/prompt variable/)
    // A page is nested, so its closing braces supply the `}}` that makes a lone `{{` malformed.
    const page = { rows: [{ title: '{{' }], view: { list: 'todos' } }
    await expect(rendered(JSON.stringify(page))).rejects.toThrow(/malformed prompt variable/)
  })

  it('assembles prose about the skills holder, separating the braces a name brought', async () => {
    const identity = plainPromptText('本机的 ORYH 技能包属于：ACME {{x}} · a@b。')
    expect(await rendered(identity)).toBe('本机的 ORYH 技能包属于：ACME { {x}} · a@b。')
  })

  it('leaves no pair of braces behind, however many the data had', () => {
    for (const text of BRACES) {
      expect(jsonPromptText({ text })).not.toContain('{{')
      expect(plainPromptText(text)).not.toContain('{{')
      expect(JSON.parse(jsonPromptText({ text }))).toEqual({ text })
    }
  })
})
