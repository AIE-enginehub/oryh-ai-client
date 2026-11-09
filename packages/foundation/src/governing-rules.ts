/**
 * The rules a tenant keeps for one kind of document, as the texts an agent and a person read.
 *
 * ORYH keeps them as rows of one table of business rules, read at `/business-rules`. Three kinds of
 * rule are keyed to an object type — who decides a submitted document, what it must satisfy when
 * filed, what follows when it reaches a state — and together they say what the tenant requires of
 * that document.
 *
 * Until 2026-10-07 (ORYH's migration 0098) they were workflow definitions at `/workflow-definitions`.
 * That path is not asked: this client is built for the ORYH of its day and keeps no way back to an
 * earlier one, so against an ORYH from before the change the read fails with that server's 404.
 */

/** The kinds of business rule that belong to an object type. A `policy` belongs to none. */
const SCOPED_KINDS: ReadonlySet<string> = new Set(['approval_flow', 'data_rule', 'linkage'])

/**
 * The published rule texts for one object type.
 * @param rows - reads every row of one ORYH list path; it throws what the transport throws.
 * @param objectType - ORYH object type, e.g. `timesheet_header`.
 * @param entityKind - `builtin` or `custom`, where the caller knows which the type is.
 * @returns each rule's text, in server order; empty when the tenant keeps none for this type.
 */
export async function governingTexts(
  rows: (path: `/${string}`) => Promise<readonly unknown[]>,
  objectType: string,
  entityKind?: string,
): Promise<string[]> {
  const scope = `${entityKind ? `entity_kind=${encodeURIComponent(entityKind)}&` : ''}object_type=${encodeURIComponent(objectType)}`
  const rules = await rows(`/business-rules?${scope}&status=published`)
  return rules.flatMap(row => {
    const rule = (row ?? {}) as Record<string, unknown>
    const scoped = typeof rule.kind === 'string' && SCOPED_KINDS.has(rule.kind)
    return scoped && typeof rule.body === 'string' && rule.body ? [rule.body] : []
  })
}
