import { OryhClientError } from './errors.js'

/** Minimal user identity returned by ORYH's authenticated `/auth/me` endpoint. */
export interface OryhUser {
  readonly id: string
  readonly email: string
  readonly name: string | null
  readonly role: string
  readonly employeeId: string | null
}

/** Tenant facts returned by ORYH's `/auth/me` endpoint. */
export interface OryhTenant {
  readonly id: string
  readonly slug: string
  readonly name: string | null
  readonly environmentId: string | null
}

/** Authenticated server identity, normalized from the ORYH envelope. */
export interface OryhIdentity {
  readonly permissions?: readonly string[]
  readonly user: OryhUser
  readonly tenant: OryhTenant
}

/** A project list item from `/projects`. */
export interface OryhProject {
  readonly createdAt?: string | null
  readonly updatedAt?: string | null
  readonly id: string
  readonly code: string | null
  readonly name: string
  readonly client: string | null
  readonly status: string
  readonly startDate: string | null
  readonly endDate: string | null
}

/** An expense claim owned by the current employee from `/expense-claims`. */
export interface OryhExpenseClaim {
  readonly id: string
  readonly employeeId: string
  readonly title: string
  readonly claimDate: string | null
  readonly currency: string
  readonly status: string
  readonly submittedAt: string | null
}

/** The target summary ORYH may include beside a todo. */
export interface OryhTodoTarget {
  readonly entityType: string
  readonly entityId: string
  readonly title: string | null
  readonly deleted: boolean
}

/** A todo list item from `/todos`. */
export interface OryhTodo {
  readonly id: string
  readonly employeeId: string
  readonly entityType: string
  readonly entityId: string
  readonly title: string
  readonly description: string | null
  readonly todoType: string | null
  readonly status: string
  readonly dueAt: string | null
  readonly target: OryhTodoTarget | null
}

/** ORYH's standard list metadata. Unpaged lists only carry `total`. */
export interface OryhListMeta {
  readonly total: number | null
  readonly page: number | null
  readonly pageSize: number | null
  readonly pages: number | null
}

/** A normalized list response. */
export interface OryhList<Value> {
  readonly data: readonly Value[]
  readonly meta: OryhListMeta
}

type JsonRecord = Record<string, unknown>

function fail(label: string): never {
  throw new OryhClientError(`ORYH returned an invalid ${label} response.`, 'invalid-response')
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label)
  return value as JsonRecord
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(label)
  return value
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return string(value, label)
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(label)
  return value
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') fail(label)
  return value
}

/** Decode ORYH's authenticated identity envelope. */
export function decodeIdentity(value: unknown): OryhIdentity {
  const data = record(record(value, 'auth/me envelope').data, 'auth/me data')
  const tenantData = record(data.tenant, 'auth/me tenant')
  const user: OryhUser = {
    id: string(data.id, 'auth/me user id'),
    email: string(data.email, 'auth/me email'),
    name: optionalString(data.name, 'auth/me name'),
    role: string(data.role, 'auth/me role'),
    employeeId: optionalString(data.employee_id, 'auth/me employee id'),
  }
  const tenant: OryhTenant = {
    id: string(data.tenant_id, 'auth/me tenant id'),
    slug: string(tenantData.slug, 'auth/me tenant slug'),
    name: optionalString(tenantData.name, 'auth/me tenant name'),
    environmentId: optionalString(data.environment_id, 'auth/me environment id'),
  }
  return {
    user,
    tenant,
    permissions: Array.isArray(data.permissions)
      ? data.permissions.filter((p): p is string => typeof p === 'string')
      : [],
  }
}

function decodeMeta(value: unknown): OryhListMeta {
  const meta = record(value, 'list metadata')
  return {
    total: optionalNumber(meta.total, 'list total'),
    page: optionalNumber(meta.page, 'list page'),
    pageSize: optionalNumber(meta.page_size, 'list page size'),
    pages: optionalNumber(meta.pages, 'list pages'),
  }
}

function decodeList<Value>(value: unknown, label: string, item: (value: unknown) => Value): OryhList<Value> {
  const envelope = record(value, `${label} envelope`)
  if (!Array.isArray(envelope.data)) fail(`${label} data`)
  return {
    data: envelope.data.map(item),
    meta: decodeMeta(envelope.meta),
  }
}

/** Decode a project list envelope from ORYH. */
export function decodeProjects(value: unknown): OryhList<OryhProject> {
  return decodeList(value, 'projects', item => {
    const project = record(item, 'project')
    return {
      id: string(project.id, 'project id'),
      code: optionalString(project.project_code, 'project code'),
      name: string(project.project_name, 'project name'),
      client: optionalString(project.client, 'project client'),
      status: string(project.status, 'project status'),
      startDate: optionalString(project.start_date, 'project start date'),
      endDate: optionalString(project.end_date, 'project end date'),
      createdAt: optionalString(project.created_at, 'project creation time'),
      updatedAt: optionalString(project.updated_at, 'project update time'),
    }
  })
}

/** Decode an employee-scoped expense-claim list envelope from ORYH. */
export function decodeExpenseClaims(value: unknown): OryhList<OryhExpenseClaim> {
  return decodeList(value, 'expense claims', item => {
    const claim = record(item, 'expense claim')
    return {
      id: string(claim.id, 'expense claim id'),
      employeeId: string(claim.employee_id, 'expense claim employee id'),
      title: string(claim.title, 'expense claim title'),
      claimDate: optionalString(claim.claim_date, 'expense claim date'),
      currency: string(claim.currency, 'expense claim currency'),
      status: string(claim.status, 'expense claim status'),
      submittedAt: optionalString(claim.submitted_at, 'expense claim submitted at'),
    }
  })
}

/** Decode a todo list envelope from ORYH. */
export function decodeTodos(value: unknown): OryhList<OryhTodo> {
  return decodeList(value, 'todos', item => {
    const todo = record(item, 'todo')
    const rawTarget = todo.target
    const target =
      rawTarget === undefined || rawTarget === null
        ? null
        : (() => {
            const target = record(rawTarget, 'todo target')
            return {
              // ORYH's target summary carries display context; the todo owns the reference.
              entityType: string(target.entity_type ?? todo.entity_type, 'todo target entity type'),
              entityId: string(target.entity_id ?? todo.entity_id, 'todo target entity id'),
              title: optionalString(target.title, 'todo target title'),
              deleted: optionalBoolean(target.deleted, 'todo target deleted'),
            }
          })()
    return {
      id: string(todo.id, 'todo id'),
      employeeId: string(todo.employee_id, 'todo employee id'),
      entityType: string(todo.entity_type, 'todo entity type'),
      entityId: string(todo.entity_id, 'todo entity id'),
      title: string(todo.title, 'todo title'),
      description: optionalString(todo.description, 'todo description'),
      todoType: optionalString(todo.todo_type, 'todo type'),
      status: string(todo.status, 'todo status'),
      dueAt: optionalString(todo.due_at, 'todo due date'),
      target,
    }
  })
}
