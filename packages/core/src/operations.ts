import { requirePage } from './access.js'
import { type ConnectionId, type OperationResultId, operationResultId } from './brand.js'
import type { ConnectionRegistry } from './connections.js'
import { decodeTodos, type OryhList, type OryhTodo } from './contracts.js'
import { OryhClientError } from './errors.js'
import type { OryhHttpClient } from './http.js'

/**
 * Operation names, limited to registered ORYH product workflows. There is one: the to-do list. The
 * expense-claim and project-list reads went with those domains (2026-10-11); the shape is kept as a list
 * so that another deterministic read can be registered beside it.
 */
export type OperationId = 'my-open-todos'

/** Values returned by the currently registered deterministic ORYH operations. */
export type OperationValue = OryhTodo

/** Safe metadata used to draw operation buttons and explain their server calls. */
export interface OperationDefinition {
  readonly id: OperationId
  readonly title: string
  readonly description: string
  readonly method: 'GET'
  readonly path: string
}

/** Public, non-secret data from one deterministic operation execution. */
export interface OperationResult<Value> {
  readonly id: OperationResultId
  readonly operationId: OperationId
  readonly connectionId: ConnectionId
  readonly executedAt: string
  readonly result: OryhList<Value>
}

/** How many done or cancelled todos load beside the open ones: the most recently changed first. */
const TODO_HISTORY = 200

export const OPERATIONS: readonly OperationDefinition[] = [
  {
    id: 'my-open-todos',
    title: '我的待办',
    description: '读取当前登录员工全部未完成的待办，以及最近的已完成、已取消待办，连同业务目标。',
    method: 'GET',
    path: '/todos?employee_id=<当前员工>&include=target',
  },
] as const

/** Host-owned executor for allowlisted deterministic ORYH operations. */
export class OperationExecutor {
  readonly #results = new Map<OperationResultId, OperationResult<OperationValue>>()
  readonly #generations = new Map<ConnectionId, number>()
  #nextResultId = 1

  constructor(
    private readonly connections: ConnectionRegistry,
    private readonly http: OryhHttpClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Execute one registered operation within a tenant-bound connection. */
  async execute(connectionId: ConnectionId, operationId: OperationId): Promise<OperationResult<OryhTodo>> {
    const connection = this.connections.requireVerified(connectionId)
    // Without an employee the operation says so itself, below, rather than as a page nobody may open.
    if (connection.identity.user.employeeId) requirePage(connection.identity, operationId)
    const generation = this.#generations.get(connectionId) ?? 0
    let result: OryhList<OperationValue>
    switch (operationId) {
      case 'my-open-todos': {
        if (connection.identity.user.employeeId === null) {
          throw new OryhClientError('This ORYH user is not linked to an employee.', 'employee-required')
        }
        const employee = connection.identity.user.employeeId
        // Every open todo, complete — what a person has to do is never cut short — and then the most recent
        // of the rest, so a todo done or cancelled can still be found and "全部状态" means all of them. The
        // list's status filter works on what is loaded; with only open todos loaded, choosing "all" or
        // "completed" had nothing to show.
        const open = decodeTodos(
          await this.http.request(connectionId, {
            path: `/todos?${new URLSearchParams({ employee_id: employee, status: 'open', include: 'target' })}`,
          }),
        )
        const recent = decodeTodos(
          await this.http.request(connectionId, {
            path: `/todos?${new URLSearchParams({
              employee_id: employee,
              include: 'target',
              page: '1',
              size: String(TODO_HISTORY),
              // Most recently changed first, not created: a todo created long ago and approved a minute ago
              // must be in the window, or the page that stayed on it shows it as it was before.
              order_by: '-updated_at',
            })}`,
          }),
        )
        const openIds = new Set(open.data.map(todo => todo.id))
        result = {
          data: [...open.data, ...recent.data.filter(todo => todo.status !== 'open' && !openIds.has(todo.id))],
          // The person's todos of every status, as ORYH counts them: what "服务端共" should say.
          meta: { ...recent.meta, page: null, pageSize: null, pages: null },
        }
        break
      }
      default:
        return assertNever(operationId)
    }
    this.connections.requireVerified(connectionId)
    if (generation !== (this.#generations.get(connectionId) ?? 0)) {
      throw new OryhClientError(
        'The connection changed while this operation was running.',
        'connection-verification-required',
      )
    }
    const execution = {
      id: operationResultId(`result-${this.#nextResultId}`),
      operationId,
      connectionId,
      executedAt: this.clock().toISOString(),
      result,
    }
    this.#nextResultId += 1
    this.#results.set(execution.id, execution)
    return execution
  }

  /**
   * Read one record of an operation's list by its id, as a list of one.
   *
   * A list loads what it loads — every open todo and the most recent of the rest — and a record outside
   * that could not be opened from Chat, however plainly the agent named it. This reads exactly that record
   * under the operation's own rule: "my" todos are the signed-in employee's, and one that is somebody
   * else's is not theirs to open here, whatever ORYH would let them read. The result is not kept for reuse.
   * @param id - the record's id.
   * @throws when the id is not one, or the record is not on this list.
   */
  async one(
    connectionId: ConnectionId,
    operationId: OperationId,
    id: string,
  ): Promise<OperationResult<OperationValue>> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id))
      throw new OryhClientError('记录编号无效。', 'request-failed')
    const connection = this.connections.requireVerified(connectionId)
    if (connection.identity.user.employeeId) requirePage(connection.identity, operationId)
    const generation = this.#generations.get(connectionId) ?? 0
    const employee = connection.identity.user.employeeId
    const notHere = () => new OryhClientError('这条记录不在这个列表里，或者你没有查看它的权限。', 'operation-not-found')
    /** One record's envelope, read as a list of one so the list's own decoder holds it to the same shape. */
    const read = async (path: `/${string}`) => {
      const body = (await this.http.request(connectionId, { path })) as { data?: unknown } | null
      if (body?.data === undefined || body.data === null) throw notHere()
      return { data: [body.data], meta: { total: 1 } }
    }
    const at = encodeURIComponent(id)
    let record: OperationValue | undefined
    switch (operationId) {
      case 'my-open-todos': {
        if (employee === null)
          throw new OryhClientError('This ORYH user is not linked to an employee.', 'employee-required')
        const todo = decodeTodos(await read(`/todos/${at}?include=target`)).data[0]
        record = todo?.employeeId === employee ? todo : undefined
        break
      }
      default:
        return assertNever(operationId)
    }
    this.connections.requireVerified(connectionId)
    if (generation !== (this.#generations.get(connectionId) ?? 0))
      throw new OryhClientError(
        'The connection changed while this operation was running.',
        'connection-verification-required',
      )
    if (record === undefined || record.id !== id) throw notHere()
    const execution = {
      id: operationResultId(`result-${this.#nextResultId}`),
      operationId,
      connectionId,
      executedAt: this.clock().toISOString(),
      result: { data: [record], meta: { total: 1, page: null, pageSize: null, pages: null } },
    }
    this.#nextResultId += 1
    return execution
  }

  /** Remove cached data and invalidate pending results for one connection. */
  clearConnection(connectionId: ConnectionId): void {
    this.#generations.set(connectionId, (this.#generations.get(connectionId) ?? 0) + 1)
    for (const [id, result] of this.#results) {
      if (result.connectionId === connectionId) this.#results.delete(id)
    }
  }

  /** Read a prior result without issuing a new ORYH API request. */
  reuse<Value extends OperationValue>(
    connectionId: ConnectionId,
    resultId: OperationResultId,
    expectedOperation?: OperationId,
  ): OperationResult<Value> {
    this.connections.requireVerified(connectionId)
    const result = this.#results.get(resultId)
    if (result === undefined) {
      throw new OryhClientError('The requested ORYH operation result no longer exists.', 'operation-not-found')
    }
    if (result.connectionId !== connectionId) {
      throw new OryhClientError('An ORYH result cannot be reused across connections.', 'cross-connection-result')
    }
    if (expectedOperation !== undefined && result.operationId !== expectedOperation) {
      throw new OryhClientError('The result belongs to another operation.', 'operation-not-found')
    }
    requirePage(this.connections.requireVerified(connectionId).identity, result.operationId)
    return result as OperationResult<Value>
  }
}

function assertNever(value: never): never {
  throw new OryhClientError(`Unsupported ORYH operation: ${String(value)}`, 'operation-not-found')
}
