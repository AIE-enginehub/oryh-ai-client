import type { OryhProject, OryhTodo } from './contracts.js'
import type { OperationResult } from './operations.js'

/** JSON-safe summary that may be appended to an AI conversation only on explicit user action. */
export interface AgentOperationContext {
  readonly source: 'oryh-deterministic-operation'
  readonly operation: string
  readonly executedAt: string
  readonly tenant: {
    readonly id: string
    readonly slug: string
  }
  readonly items: readonly Record<string, unknown>[]
  readonly total: number | null
}

/**
 * Project a deterministic result into concise model-visible data.
 * The caller decides whether the user asked to include it in the conversation.
 */
export function agentContextForTodos(
  result: OperationResult<OryhTodo>,
  tenant: { readonly id: string; readonly slug: string },
): AgentOperationContext {
  return {
    source: 'oryh-deterministic-operation',
    operation: result.operationId,
    executedAt: result.executedAt,
    tenant,
    total: result.result.meta.total,
    items: result.result.data.map(todo => ({
      id: todo.id,
      title: todo.title,
      status: todo.status,
      dueAt: todo.dueAt,
      entityType: todo.entityType,
      entityId: todo.entityId,
      targetTitle: todo.target?.title ?? null,
    })),
  }
}

/** Project a project list into concise model-visible data after explicit user action. */
export function agentContextForProjects(
  result: OperationResult<OryhProject>,
  tenant: { readonly id: string; readonly slug: string },
): AgentOperationContext {
  return {
    source: 'oryh-deterministic-operation',
    operation: result.operationId,
    executedAt: result.executedAt,
    tenant,
    total: result.result.meta.total,
    items: result.result.data.map(project => ({
      id: project.id,
      code: project.code,
      name: project.name,
      client: project.client,
      status: project.status,
    })),
  }
}
