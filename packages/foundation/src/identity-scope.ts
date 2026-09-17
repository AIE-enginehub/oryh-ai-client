import type { Brand } from './brand.js'

/**
 * The connection facts an identity scope is made of; `ConnectionSummary` satisfies this shape.
 * Declared structurally so every package can build a scope without depending on the core.
 */
export interface ScopedConnection {
  readonly origin: string
  readonly identity: {
    readonly tenant: { readonly id: string }
    readonly user: { readonly id: string; readonly employeeId?: string | null }
  }
}

/**
 * Who a piece of state belongs to: one deployment, one tenant, one user and (for employee scopes) one
 * employee. It is the key stored beside drafts, intents and chat bindings, and the value every read
 * compares against the connection as verified now, so a connection whose identity changed under it
 * cannot read or write what the previous identity left behind.
 *
 * The serialised form is a JSON array. It is stable on purpose: existing stores hold it verbatim.
 */
export type IdentityScope = Brand<string, 'IdentityScope'>

/** Scope of state that belongs to one employee: origin, tenant, user and employee. */
export function employeeScope(connection: ScopedConnection): IdentityScope {
  const { origin, identity } = connection
  return JSON.stringify([
    origin,
    identity.tenant.id,
    identity.user.id,
    identity.user.employeeId ?? null,
  ]) as IdentityScope
}

/** Scope of state that belongs to one user in one tenant, whether or not they are an employee. */
export function userScope(connection: ScopedConnection): IdentityScope {
  const { origin, identity } = connection
  return JSON.stringify([origin, identity.tenant.id, identity.user.id]) as IdentityScope
}

/** The parts of an employee scope, for code that has to name the holder. */
export interface EmployeeScopeParts {
  readonly origin: string
  readonly tenantId: string
  readonly userId: string
  readonly employeeId: string | null
}

/**
 * Read an employee scope back.
 * @param scope - a scope produced by {@link employeeScope}.
 * @returns its parts.
 * @throws when the value is not an employee scope.
 */
export function parseEmployeeScope(scope: string): EmployeeScopeParts {
  const parsed: unknown = JSON.parse(scope)
  if (!Array.isArray(parsed) || parsed.length !== 4) throw new Error('Not an employee identity scope')
  const [origin, tenantId, userId, employeeId] = parsed as unknown[]
  if (typeof origin !== 'string' || typeof tenantId !== 'string' || typeof userId !== 'string')
    throw new Error('Not an employee identity scope')
  return { origin, tenantId, userId, employeeId: typeof employeeId === 'string' ? employeeId : null }
}
