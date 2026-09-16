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
    permissions:['master_data.manage','expense.submit_own','timesheet.submit_own','approval.record','order.submit_own','inventory.manage'],
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

    await expect(executor.execute(connection.id, 'list-projects')).rejects.toMatchObject({
      code: 'connection-verification-required',
    })
    expect(fetcher.calls).toEqual([])
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
        data: [{
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
        }],
        meta: { total: 1 },
      }),
    ])
    const http = new OryhHttpClient(connections, credentials, fetcher.fetch)
    const executor = new OperationExecutor(connections, http, () => new Date('2026-08-28T00:00:00Z'))

    const result = await executor.execute(first.id, 'my-open-todos')
    const reused = executor.reuse(first.id, result.id)

    expect(reused).toEqual(result)
    expect(result.result.data[0]?.target).toMatchObject({ entityType: 'project', entityId: 'project-1' })
    expect(fetcher.calls).toHaveLength(1)
    expect(fetcher.calls[0]?.input).toContain('employee_id=employee-1')
    expect(fetcher.calls[0]?.input).toContain('status=open')
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
      items: [{ title: 'Review project plan', targetTitle: 'Pilot' }],
    })
    expect(JSON.stringify(context)).not.toContain('first-key')
  })

  it('executes an employee-bound expense-claim view through a fixed API program', async () => {
    const connections = new ConnectionRegistry()
    const connection = connections.add({ origin: 'https://oryh.example', identity: identity('employee-1') })
    connections.markVerified(connection.id, identity('employee-1'))
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh-token', expiresAt: null })
    const fetcher = new ScriptedFetcher([
      jsonResponse(200, {
        data: [{
          id: 'claim-1', employee_id: 'employee-1', title: '客户拜访交通费', claim_date: '2026-08-28',
          currency: 'CNY', status: 'submitted', submitted_at: '2026-08-28T08:00:00Z',
        }],
        meta: { total: 1 },
      }),
    ])
    const executor = new OperationExecutor(
      connections,
      new OryhHttpClient(connections, credentials, fetcher.fetch),
      () => new Date('2026-08-28T00:00:00Z'),
    )

    const result = await executor.execute(connection.id, 'my-expense-claims')

    expect(result).toMatchObject({
      operationId: 'my-expense-claims',
      result: {
        data: [{ title: '客户拜访交通费', currency: 'CNY', status: 'submitted' }],
      },
    })
    expect(fetcher.calls).toHaveLength(1)
    expect(fetcher.calls[0]?.input).toBe('https://oryh.example/api/v1/expense-claims?employee_id=employee-1')
    expect(executor.reuse(connection.id, result.id)).toEqual(result)
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
      permissions:['master_data.manage','expense.submit_own','timesheet.submit_own','approval.record','order.submit_own','inventory.manage'],
    user: {
        ...identity('employee-1').user,
        employeeId: null,
      },
    })
    const credentials = new MemoryCredentialVault()
    await credentials.write(connection.id, { accessKey: 'access-key', refreshToken: 'refresh-token', expiresAt: null })
    const fetcher = new ScriptedFetcher([])
    const executor = new OperationExecutor(connections, new OryhHttpClient(connections, credentials, fetcher.fetch))

    await expect(executor.execute(connection.id, 'my-expense-claims')).rejects.toMatchObject({ code: 'employee-required' })
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
  let release: (value: typeof response) => void = () => { throw new Error('Request not started') }
  let started: () => void = () => {}
  const pendingStarted = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const executor = new OperationExecutor(connections, new OryhHttpClient(connections, credentials, async () => {
    calls += 1
    return calls === 1 ? response : new Promise(resolve => { release = resolve; started() })
  }))
  const cached = await executor.execute(connection.id, 'list-projects')
  expect(() => executor.reuse(connection.id, cached.id, 'my-open-todos')).toThrow('another operation')
  const pending = executor.execute(connection.id, 'list-projects')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'connection-verification-required' })
  await pendingStarted
  executor.clearConnection(connection.id)
  release(response)
  await rejected
  expect(() => executor.reuse(connection.id, cached.id)).toThrow('no longer exists')
  connections.remove(connection.id)
  expect(() => executor.reuse(connection.id, cached.id)).toThrow('connection no longer exists')
})
