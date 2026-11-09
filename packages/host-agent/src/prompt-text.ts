/**
 * Text on its way into the system prompt is scanned for `{{variable}}` references, and one that is
 * unknown or malformed throws: the assembly fails, and the session cannot talk at all. Two of our
 * contexts carry ORYH's data — the page the person is looking at, and who the skills belong to — so a
 * to-do titled `{{x}}`, or an expense note with a stray `{{`, would silently end that session.
 *
 * Harness has no escape syntax for this (checked against `interpolate` in @deepseek-ai/dsh-system-prompt:
 * a `{{` with any later `}}` is malformed, and a well-formed name that is not registered is unknown), so
 * the text is made safe here, where it is composed.
 */

/** A `{` that opens a pair. Replacing the opener alone leaves runs of braces intact. */
const OPENING_BRACE = /\{(?=\{)/g

/**
 * ORYH's data as JSON for the prompt: a `{{` the data carried becomes `{{`, the same two characters
 * written as JSON escapes them. What a reader of the JSON sees does not change.
 *
 * Only string contents can produce a `{{` here — `JSON.stringify` follows a structural `{` with `"` or
 * `}`, never another `{` — so nothing about the document's shape is rewritten.
 */
export function jsonPromptText(value: unknown): string {
  return JSON.stringify(value).replaceAll(OPENING_BRACE, '\\u007b')
}

/**
 * ORYH's data inside prose for the prompt: a `{{` is separated by a space. Prose is read as it is
 * written, so there is no escape that keeps the text identical; a space inside a name that contains
 * `{{` is the smaller harm, next to a session that cannot answer.
 */
export function plainPromptText(text: string): string {
  return text.replaceAll(OPENING_BRACE, '{ ')
}
