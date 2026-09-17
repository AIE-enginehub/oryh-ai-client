import { requirePage } from './access.js'
import { type ConnectionId, type OperationResultId, operationResultId } from './brand.js'
import type { ConnectionRegistry } from './connections.js'
import {
  decodeExpenseClaims,
  decodeProjects,
  decodeTodos,
  type OryhExpenseClaim,
  type OryhList,
  type OryhProject,
  type OryhTodo,
} from './contracts.js'
import { OryhClientError } from './errors.js'
import type { OryhHttpClient } from './http.js'

/** Operation names intentionally limited to registered ORYH product workflows. */
export type OperationId = 'my-open-todos' | 'my-expense-claims' | 'list-projects'

/** Values returned by the currently registered deterministic ORYH operations. */
export type OperationValue = OryhTodo | OryhExpenseClaim | OryhProject

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

export const OPERATIONS: readonly OperationDefinition[] = [
  {
    id: 'my-open-todos',
    title: '我的待办',
    description: '读取当前登录员工尚未完成的待办及其业务目标。',
    method: 'GET',
    path: '/todos?status=open&include=target',
  },
  {
    id: 'my-expense-claims',
    title: '我的费用申请',
    description: '读取当前登录员工的费用申请及其处理状态。',
    method: 'GET',
    path: '/expense-claims?employee_id=<当前员工>',
  },
  {
    id: 'list-projects',
    title: '项目列表',
    description: '读取当前企业可见的项目列表。',
    method: 'GET',
    path: '/projects',
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
  async execute(connectionId: ConnectionId, operationId: 'my-open-todos'): Promise<OperationResult<OryhTodo>>
  async execute(connectionId: ConnectionId, operationId: 'list-projects'): Promise<OperationResult<OryhProject>>
  async execute(
    connectionId: ConnectionId,
    operationId: 'my-expense-claims',
  ): Promise<OperationResult<OryhExpenseClaim>>
  async execute(
    connectionId: ConnectionId,
    operationId: OperationId,
  ): Promise<OperationResult<OryhTodo> | OperationResult<OryhExpenseClaim> | OperationResult<OryhProject>> {
    const connection = this.connections.requireVerified(connectionId)
    if (operationId === 'list-projects' || connection.identity.user.employeeId)
      requirePage(connection.identity, operationId)
    const generation = this.#generations.get(connectionId) ?? 0
    let result: OryhList<OperationValue>
    switch (operationId) {
      case 'my-open-todos': {
        if (connection.identity.user.employeeId === null) {
          throw new OryhClientError('This ORYH user is not linked to an employee.', 'employee-required')
        }
        const query = new URLSearchParams({
          employee_id: connection.identity.user.employeeId,
          status: 'open',
          include: 'target',
        })
        result = decodeTodos(await this.http.request(connectionId, { path: `/todos?${query.toString()}` }))
        break
      }
      case 'my-expense-claims': {
        if (connection.identity.user.employeeId === null) {
          throw new OryhClientError('This ORYH user is not linked to an employee.', 'employee-required')
        }
        const query = new URLSearchParams({ employee_id: connection.identity.user.employeeId })
        result = decodeExpenseClaims(
          await this.http.request(connectionId, { path: `/expense-claims?${query.toString()}` }),
        )
        break
      }
      case 'list-projects':
        result = decodeProjects(await this.http.request(connectionId, { path: '/projects' }))
        break
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
    return execution as OperationResult<OryhTodo> | OperationResult<OryhExpenseClaim> | OperationResult<OryhProject>
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
