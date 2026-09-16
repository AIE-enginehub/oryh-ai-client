import { describe, expect, it } from 'vitest'
import {
  connectionId,
  deviceAuthorizationId,
  operationResultId,
  savedOperationId,
  type OryhClientRemote,
  type OryhOperationResult,
} from '@oryh/ai-client-core'
import { OryhWorkspace, OryhWorkspaceError } from '../src/index.js'

const connection = {
  id: connectionId('oryh-1'),
  origin: 'https://oryh.example',
  identity: {
    user: { id: 'user-1', email: 'member@example.com', name: 'Member', role: 'member', employeeId: 'employee-1' },
    tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme' },
    environmentId: null,
  },
  connectedAt: '2026-08-28T00:00:00Z',
} as const

function projectResult(id = operationResultId('result-1')): OryhOperationResult {
  return {
    id,
    operationId: 'list-projects',
    connectionId: connection.id,
    executedAt: '2026-08-28T00:00:00Z',
    result: {
      data: [{ id: 'project-1', code: 'P-01', name: 'Pilot', client: null, status: 'active', startDate: null, endDate: null }],
      meta: { total: 1 },
    },
  }
}

function remoteFixture(): OryhClientRemote & { readonly calls: string[] } {
  const calls: string[] = []
  const saved = {
    id: savedOperationId('saved-operation-1'),
    connectionId: connection.id,
    operationId: 'list-projects' as const,
    sourceResultId: operationResultId('result-1'),
    label: '重点项目',
    createdAt: '2026-08-28T00:00:00Z',
  }
  return {
    calls,
    beginConnection: async () => {
      calls.push('beginConnection')
      return {
        authorizationId: deviceAuthorizationId('authorization-1'),
        prompt: {
          userCode: 'ABCD-EFGH', verificationUri: 'https://oryh.example/web/device',
          verificationUriComplete: 'https://oryh.example/web/device?code=ABCD-EFGH', expiresInSeconds: 900, pollIntervalSeconds: 5,
        },
      }
    },
    pollConnection: async () => {
      calls.push('pollConnection')
      return { state: 'connected', connection }
    },
    cancelConnection: async () => { calls.push('cancelConnection') },
    listConnections: async () => { calls.push('listConnections'); return [connection] },
    verifyConnection: async () => { calls.push('verifyConnection'); return connection },
    listOperations: async () => {
      calls.push('listOperations')
      return [{ id: 'list-projects', title: '项目列表', description: '项目', method: 'GET', path: '/projects' }]
    },
    execute: async () => { calls.push('execute'); return projectResult() },
    reuse: async (_connectionId, _operationId, resultId) => { calls.push('reuse'); return projectResult(resultId) },
    saveResult: async () => { calls.push('saveResult'); return saved },
    listSavedOperations: async () => { calls.push('listSavedOperations'); return [saved] },
    refreshSavedOperation: async () => { calls.push('refreshSavedOperation'); return projectResult(operationResultId('result-2')) },
    disconnect: async () => { calls.push('disconnect') },
  }
}

describe('OryhWorkspace', () => {
  it('drives direct operations, cache reuse, and saved refreshes without an AI request', async () => {
    const remote = remoteFixture()
    const workspace = new OryhWorkspace(remote)

    await workspace.load()
    expect(workspace.snapshot().activeConnectionId).toBe(connection.id)

    const first = await workspace.run('list-projects')
    expect(first.result.data).toHaveLength(1)
    await workspace.reuse('list-projects', first.id)
    await workspace.saveCurrentResult('重点项目')
    await workspace.refreshSavedOperation(savedOperationId('saved-operation-1'))

    expect(remote.calls).toEqual([
      'listConnections', 'listOperations', 'verifyConnection', 'listSavedOperations',
      'execute', 'reuse', 'saveResult', 'listSavedOperations', 'refreshSavedOperation',
    ])
    expect(remote.calls).not.toContain('askModel')
  })

  it('requires an explicit tenant choice when more than one connection exists', async () => {
    const remote = remoteFixture()
    const second = { ...connection, id: connectionId('oryh-2') }
    remote.listConnections = async () => [connection, second]
    const workspace = new OryhWorkspace(remote)

    await workspace.load()
    expect(workspace.snapshot().activeConnectionId).toBeUndefined()
    await expect(workspace.run('list-projects')).rejects.toMatchObject<OryhWorkspaceError>({
      code: 'connection-required',
    })

    await workspace.selectConnection(connection.id)
    await expect(workspace.run('list-projects')).resolves.toMatchObject({ connectionId: connection.id })
  })

  it('owns only the safe device-flow prompt and drops it after approval', async () => {
    const remote = remoteFixture()
    const workspace = new OryhWorkspace(remote)

    await workspace.beginConnection('https://oryh.example', 'ORYH AI Client')
    expect(JSON.stringify(workspace.snapshot().pendingConnection)).not.toContain('device_code')
    const outcome = await workspace.pollConnection()

    expect(outcome.state).toBe('connected')
    expect(workspace.snapshot().pendingConnection).toBeUndefined()
    expect(workspace.snapshot().activeConnectionId).toBe(connection.id)
  })

  it('disconnects the current account and verifies the remaining account before making it active', async () => {
    const remote = remoteFixture()
    const second = {
      ...connection,
      id: connectionId('oryh-2'),
      identity: {
        ...connection.identity,
        user: { ...connection.identity.user, id: 'user-2', email: 'another@example.com' },
      },
    }
    remote.listConnections = async () => [connection, second]
    remote.verifyConnection = async connectionId => {
      remote.calls.push('verifyConnection')
      return connectionId === connection.id ? connection : second
    }
    const workspace = new OryhWorkspace(remote)

    await workspace.load()
    await workspace.selectConnection(connection.id)
    await workspace.disconnect()

    expect(workspace.snapshot()).toMatchObject({
      connections: [second],
      activeConnectionId: second.id,
      currentResult: undefined,
    })
    expect(remote.calls).toEqual([
      'listOperations', 'verifyConnection', 'listSavedOperations',
      'disconnect', 'verifyConnection', 'listSavedOperations',
    ])
  })
})

it.each(['run', 'reuse', 'refresh'] as const)('discards a late %s result even after switching A to B to A', async action => {
  const remote = remoteFixture()
  const second = { ...connection, id: connectionId('oryh-2') }
  remote.listConnections = async () => [connection, second]
  remote.verifyConnection = async id => id === connection.id ? connection : second
  let release: (value: OryhOperationResult) => void = () => { throw new Error('Request not started') }
  const delayed = () => new Promise<OryhOperationResult>(resolve => { release = resolve })
  remote.execute = delayed
  remote.reuse = delayed
  remote.refreshSavedOperation = delayed
  const workspace = new OryhWorkspace(remote)
  await workspace.load()
  await workspace.selectConnection(connection.id)
  const pending = action === 'run' ? workspace.run('list-projects')
    : action === 'reuse' ? workspace.reuse('list-projects', operationResultId('result-1'))
      : workspace.refreshSavedOperation(savedOperationId('saved-operation-1'))
  const rejected = expect(pending).rejects.toMatchObject({ code: 'stale-request' })
  await workspace.selectConnection(second.id)
  await workspace.selectConnection(connection.id)
  release(projectResult())
  await rejected
  expect(workspace.snapshot().currentResult).toBeUndefined()
})

it('clears the active enterprise and cached views when selection verification fails', async () => {
  const remote = remoteFixture()
  const second = { ...connection, id: connectionId('oryh-2') }
  remote.listConnections = async () => [connection, second]
  const workspace = new OryhWorkspace(remote)
  await workspace.load()
  await workspace.selectConnection(connection.id)
  await workspace.run('list-projects')
  remote.verifyConnection = async () => { throw new Error('Verification failed') }
  await expect(workspace.selectConnection(second.id)).rejects.toThrow('Verification failed')
  expect(workspace.snapshot()).toMatchObject({ activeConnectionId: undefined, currentResult: undefined, savedOperations: [] })
  await expect(workspace.run('list-projects')).rejects.toMatchObject({ code: 'connection-required' })
})

it('does not publish an earlier enterprise selection that finishes last', async () => {
  const remote = remoteFixture()
  const second = { ...connection, id: connectionId('oryh-2') }
  remote.listConnections = async () => [connection, second]
  let release: (value: typeof connection) => void = () => { throw new Error('Verification not started') }
  remote.verifyConnection = async id => id === second.id ? second : new Promise(resolve => { release = resolve })
  const workspace = new OryhWorkspace(remote)
  await workspace.load()
  const first = workspace.selectConnection(connection.id)
  const rejected = expect(first).rejects.toMatchObject({ code: 'stale-request' })
  await workspace.selectConnection(second.id)
  release(connection)
  await rejected
  expect(workspace.snapshot().activeConnectionId).toBe(second.id)
})
