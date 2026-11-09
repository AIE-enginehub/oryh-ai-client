import { describe, expect, it } from 'vitest'
import {
  agentContextForTodos,
  ConnectionRegistry,
  MemoryCredentialVault,
  OperationExecutor,
  OryhClientError,
  OryhHttpClient,
} from '../src/index.js'
import { jsonResponse, ScriptedFetcher } from './fixtures.js'

function identity(employeeId: string) {
  return {
    permissions: [
      'master_data.manage',
      'expense.submit_own',
      'timesheet.submit_own',
      'approval.record',
      'order.submit_own',
      'inventory.manage',
    ],
    user: {
      id: `user-${employeeId}`,
      email: `${employeeId}@example.com`,
      name: null,
      role: 'member',
      employeeId,
    },
    tenant: {
      id: 'tenant-1',
      slug: 'acme',
      name: 'Acme',
      environmentId: null,
    },
  }
}

describe('OperationExecutor', () => {
  it('refuses business operations from a restored connection until this Host process verifies it', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity('employee-1') })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh-token', expiresAt: null })
    const fetcher = new ScriptedFetcher([])
    const executor = new OperationExecutor(connections, new OryhHttpClient(connections, credentials, fetcher.fetch))

    await expect(executor.execute(connection.id, 'my-open-todos')).rejects.toMatchObject({
      code: 'connection-verification-required',
    })
    expect(fetcher.calls).toEqual([])
  })

  it('reads one record of a list by id, and only a record that belongs on that list', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity('employee-1') })
    connections.markVerified(connection.id, identity('employee-1'))
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh-token', expiresAt: null })
    const todo = (id: string, employee: string) => ({
      id,
      employee_id: employee,
      entity_type: 'project',
      entity_id: 'project-1',
      title: 'Review project plan',
      description: null,
      todo_type: null,
      status: 'completed',
      due_at: null,
    })
    const fetcher = new ScriptedFetcher([
      jsonResponse(200, { data: todo('todo-9', 'employee-1') }),
      jsonResponse(200, { data: todo('todo-8', 'employee-2') }),
      jsonResponse(200, { data: null }),
    ])
    const executor = new OperationExecutor(connections, new OryhHttpClient(connections, credentials, fetcher.fetch))

    // An old todo the list no longer loads is still the person's, and comes as a list of one.
    const one = await executor.one(connection.id, 'my-open-todos', 'todo-9')
    expect(one.result).toMatchObject({ data: [{ id: 'todo-9', employeeId: 'employee-1' }], meta: { total: 1 } })
    expect(fetcher.calls[0]?.input).toContain('/todos/todo-9?include=target')
    // Not kept: a read of one record is not a result to save or reuse as the list.
    expect(() => executor.reuse(connection.id, one.id)).toThrow()
    // Someone else's todo is not on "my todos", whatever ORYH lets this person read.
    await expect(executor.one(connection.id, 'my-open-todos', 'todo-8')).rejects.toMatchObject({
      code: 'operation-not-found',
    })
    // One ORYH does not have is not on the list either.
    await expect(executor.one(connection.id, 'my-open-todos', 'todo-7')).rejects.toMatchObject({
      code: 'operation-not-found',
    })
    // An id that is not one never reaches ORYH.
    for (const id of ['', '../auth/me', 'a/b', 'a?b=1', 'x'.repeat(201)])
      await expect(executor.one(connection.id, 'my-open-todos', id)).rejects.toMatchObject({ code: 'request-failed' })
    expect(fetcher.calls).toHaveLength(3)
  })

  it('executes a registered todo operation once and reuses the result locally', async () => {
    const connections = new ConnectionRegistry()
    const first = connections.add({ origin: 'https://oryh.example', identity: identity('employee-1') })
    const second = connections.add({ origin: 'https://oryh.example', identity: identity('employee-2') })
    connections.markVerified(first.id, identity('employee-1'))
    connections.markVerified(second.id, identity('employee-2'))
    const credentials = new MemoryCredentialVault()
    await credentials.write(first.id, { accessKey: 'first-key', refreshToken: 'first-refresh', expiresAt: null })
    await credentials.write(second.id, { accessKey: 'second-key', refreshToken: 'second-refresh', expiresAt: null })
    const fetcher = new ScriptedFetcher([
      jsonResponse(200, {
        data: [
          {
            id: 'todo-1',
            employee_id: 'employee-1',
            entity_type: 'project',
            entity_id: 'project-1',
            title: 'Review project plan',
            description: null,
            todo_type: null,
            status: 'open',
            due_at: null,
            target: { object_type: 'project', title: 'Pilot', deleted: false },
          },
        ],
        meta: { total: 1 },
      }),
      // The most recent todos of every status: the open one again, and one the person has done.
      jsonResponse(200, {
        data: [
          {
            id: 'todo-2',
            employee_id: 'employee-1',
            entity_type: 'timesheet_header',
            entity_id: 'th-9',
            title: 'Approve timesheet',
            description: null,
            todo_type: 'approval',
            status: 'completed',
            due_at: null,
          },
          {
            id: 'todo-1',
            employee_id: 'employee-1',
            entity_type: 'project',
            entity_id: 'project-1',
            title: 'Review project plan',
            description: null,
            todo_type: null,
            status: 'open',
            due_at: null,
          },
        ],
        meta: { total: 2, page: 1, page_size: 200, pages: 1 },
      }),
    ])
    const http = new OryhHttpClient(connections, credentials, fetcher.fetch)
    const executor = new OperationExecutor(connections, http, () => new Date('2026-08-28T00:00:00Z'))

    const result = await executor.execute(first.id, 'my-open-todos')
    const reused = executor.reuse(first.id, result.id)

    expect(reused).toEqual(result)
    expect(result.result.data[0]?.target).toMatchObject({ entityType: 'project', entityId: 'project-1' })
    // Every open todo, then the recent others without repeating an open one: a completed todo can be found.
    expect(result.result.data.map(todo => [todo.id, todo.status])).toEqual([
      ['todo-1', 'open'],
      ['todo-2', 'completed'],
    ])
    expect(result.result.meta.total).toBe(2)
    expect(fetcher.calls).toHaveLength(2)
    expect(fetcher.calls[0]?.input).toContain('employee_id=employee-1')
    expect(fetcher.calls[0]?.input).toContain('status=open')
    expect(fetcher.calls[1]?.input).toContain('employee_id=employee-1')
    expect(fetcher.calls[1]?.input).not.toContain('status=')
    expect(fetcher.calls[1]?.input).toContain('size=200')
    // Most recently changed first, so a todo completed just now is in the window whenever it was created.
    expect(fetcher.calls[1]?.input).toContain('order_by=-updated_at')
    let crossConnectionError: unknown
    try {
      executor.reuse(second.id, result.id)
    } catch (error) {
      crossConnectionError = error
    }
    expect(crossConnectionError).toBeInstanceOf(OryhClientError)
    expect((crossConnectionError as OryhClientError).code).toBe('cross-connection-result')
    const context = agentContextForTodos(result, { id: 'tenant-1', slug: 'acme' })
    expect(context).toMatchObject({
      source: 'oryh-deterministic-operation',
      items: [
        { title: 'Review project plan', status: 'open', targetTitle: 'Pilot' },
        { title: 'Approve timesheet', status: 'completed' },
      ],
    })
    expect(JSON.stringify(context)).not.toContain('first-key')
  })

  it('does not issue employee-scoped requests for an account without an employee record', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({
      origin: 'https://oryh.example',
      identity: {
        ...identity('employee-1'),
        user: {
          ...identity('employee-1').user,
          employeeId: null,
        },
      },
    })
    connections.markVerified(connection.id, {
      ...identity('employee-1'),
      permissions: [
        'master_data.manage',
        'expense.submit_own',
        'timesheet.submit_own',
        'approval.record',
        'order.submit_own',
        'inventory.manage',
      ],
      user: {
        ...identity('employee-1').user,
        employeeId: null,
      },
    })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh-token', expiresAt: null })
    const fetcher = new ScriptedFetcher([])
    const executor = new OperationExecutor(connections, new OryhHttpClient(connections, credentials, fetcher.fetch))

    await expect(executor.execute(connection.id, 'my-open-todos')).rejects.toMatchObject({
      code: 'employee-required',
    })
    expect(fetcher.calls).toEqual([])
  })
})

it('discards cached and pending results when a connection is invalidated', async () => {
  const connections = new ConnectionRegistry()
  const connection = connections.add({ origin: 'https://oryh.example', identity: identity('employee-1') })
  connections.markVerified(connection.id, connection.identity)
  const credentials = new MemoryCredentialVault()
  await credentials.write(connection.id, { accessKey: 'test', refreshToken: 'test', expiresAt: null })
  const response = jsonResponse(200, { data: [], meta: { total: 0 } })
  let release: (value: typeof response) => void = () => {
    throw new Error('Request not started')
  }
  let started: () => void = () => {}
  const pendingStarted = new Promise<void>(resolve => {
    started = resolve
  })
  let calls = 0
  const executor = new OperationExecutor(
    connections,
    new OryhHttpClient(connections, credentials, async () => {
      calls += 1
      // The first list's two reads answer; the second list's first read is the one left pending.
      return calls !== 3
        ? response
        : new Promise(resolve => {
            release = resolve
            started()
          })
    }),
  )
  const cached = await executor.execute(connection.id, 'my-open-todos')
  const pending = executor.execute(connection.id, 'my-open-todos')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'connection-verification-required' })
  await pendingStarted
  executor.clearConnection(connection.id)
  release(response)
  await rejected
  expect(() => executor.reuse(connection.id, cached.id)).toThrow('no longer exists')
  connections.remove(connection.id)
  expect(() => executor.reuse(connection.id, cached.id)).toThrow('connection no longer exists')
})
