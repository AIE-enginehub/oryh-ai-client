/**
 * The menu a person's role implies: one entry for each ORYH collection their permissions let them work.
 *
 * A finance clerk holds `invoice.manage:payroll`, `payment.record`, `fin_account.manage` — and the menu
 * this client ships had nothing for any of them, because it was a fixed list of pages. What the person
 * works is in their permissions, and what collections exist is in ORYH's own catalogue; this reads the
 * one against the other, so a role ORYH adds is served the day its permissions are granted.
 *
 * The rules, and nothing else:
 *   - Permissions read `domain.verb[:scope]` (ORYH `app/core/permissions.py`). `*_own` verbs are the
 *     person's own documents, which this client's own pages already show — they add nothing here.
 *   - A domain resolves through the catalogue: a collection whose name, or one of the words ORYH says
 *     mean it, is the domain. A few domains are named differently from what they govern, and those
 *     are listed below; a domain that resolves to nothing adds nothing rather than a guess.
 *   - A collection that is configuration rather than business documents is left out (listed below).
 *   - A scope narrows the entry when the collection filters by `direction`, which is what ORYH scopes
 *     invoicing by: `invoice.manage:payroll` is payslips. A bare grant covers every scope, so it wins.
 */
import type { RecordFilterField } from './contracts.js'
import { collectionLabels, scopeLabels } from './views.js'

/** One entry of ORYH's own catalogue: a collection, its list path, and the words that mean it. */
export interface CatalogueEntry {
  object_type: string
  path: string
  also_called?: string[]
}

/** One entry of a role's menu: a collection, how it is narrowed, and what it is called. */
export interface RoleEntry {
  collection: string
  filters: Record<string, string>
  label: string
  /** The permissions that imply it: with none of them left, the entry is gone, whatever a cache still holds. */
  grants: string[]
}

/**
 * Permission domains ORYH names differently from the collection they govern (ORYH's own permission
 * titles say which): 查看/定薪 → 薪资档案, 请假 → 请假单, 采购申请, 报销单, 工时表.
 */
const DOMAIN_COLLECTIONS: Readonly<Record<string, string>> = {
  payroll: 'pay-histories',
  leave: 'employee-leaves',
  purchase: 'purchase-requests',
  expense: 'expense-claims',
  timesheet: 'timesheet-headers',
}

/**
 * Collections a permission governs that are configuration or machinery rather than documents a role
 * works through in a list: the agent's skills, the company's policies, the record of workflow runs, and
 * the one collection every tenant-defined object type shares. Found by resolving every system permission
 * ORYH defines against its catalogue (the role-menu tests do this in full, so a change shows there).
 */
const CONFIGURATION = new Set(['skills', 'policies', 'flow-runs', 'business-objects'])

/** What a scope may be: a word, never a path or a value with punctuation. */
const SCOPE = /^[a-z][a-z0-9_]{0,31}$/

/**
 * The collection a permission domain governs.
 * @param domain - the part of a permission before the dot.
 * @param catalogue - ORYH's `/builtin-object-types`.
 * @returns the collection's name as its list path spells it, or undefined.
 */
export function collectionOf(domain: string, catalogue: readonly CatalogueEntry[]): string | undefined {
  const named = DOMAIN_COLLECTIONS[domain]
  const entry = named
    ? catalogue.find(e => e.path === `/${named}`)
    : catalogue.find(e => e.object_type === domain || (e.also_called ?? []).includes(domain))
  const path = entry?.path
  return path && /^\/[a-z][a-z0-9-]{0,63}$/.test(path) ? path.slice(1) : undefined
}

/**
 * A role's menu.
 * @param permissions - what ORYH granted this identity.
 * @param catalogue - ORYH's collections.
 * @param declared - the query parameters each collection declares, for deciding whether a scope narrows it.
 * @returns entries in the order their first permission appears, one per collection and narrowing.
 */
export async function roleMenu(
  permissions: readonly string[],
  catalogue: readonly CatalogueEntry[],
  declared: (collection: string) => Promise<readonly RecordFilterField[]>,
): Promise<RoleEntry[]> {
  // collection → the scopes granted, or null when a bare grant covers all of it
  const scopes = new Map<string, Set<string> | null>()
  // collection → scope (or '*' for a bare grant) → the permissions granting it
  const granted = new Map<string, Map<string, string[]>>()
  const grant = (collection: string, scope: string, permission: string) => {
    const byScope = granted.get(collection) ?? new Map<string, string[]>()
    byScope.set(scope, [...(byScope.get(scope) ?? []), permission])
    granted.set(collection, byScope)
  }
  for (const permission of permissions) {
    const [verb = '', scope] = permission.split(':', 2)
    const [domain, action] = verb.split('.', 2)
    if (!domain || !action || action.endsWith('_own')) continue
    const collection = collectionOf(domain, catalogue)
    if (!collection || CONFIGURATION.has(collection)) continue
    if (scope === undefined || scope === '*') {
      scopes.set(collection, null)
      grant(collection, '*', permission)
      continue
    }
    if (!SCOPE.test(scope)) continue
    grant(collection, scope, permission)
    const current = scopes.get(collection)
    if (current === null) continue
    scopes.set(collection, new Set([...(current ?? []), scope]))
  }
  const grantsFor = (collection: string, scope?: string) => {
    const byScope = granted.get(collection)
    return [
      ...new Set(
        scope === undefined
          ? [...(byScope?.values() ?? [])].flat()
          : [...(byScope?.get(scope) ?? []), ...(byScope?.get('*') ?? [])],
      ),
    ]
  }
  const entries: RoleEntry[] = []
  for (const [collection, scoped] of scopes) {
    const name = collectionLabels[collection] ?? collection
    const byDirection =
      scoped !== null && (await declared(collection).catch(() => [])).some(field => field.name === 'direction')
    if (!byDirection) {
      entries.push({ collection, filters: {}, label: name, grants: grantsFor(collection) })
      continue
    }
    for (const scope of scoped!)
      entries.push({
        collection,
        filters: { direction: scope },
        label: `${name}·${scopeLabels[scope] ?? scope}`,
        grants: grantsFor(collection, scope),
      })
  }
  return entries
}
