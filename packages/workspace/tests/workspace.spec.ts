import {
  connectionId,
  deviceAuthorizationId,
  type OryhClientRemote,
  type OryhOperationResult,
  operationResultId,
  savedOperationId,
} from '@oryh/ai-client-core'
import { describe, expect, it } from 'vitest'
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
    operationId: 'my-open-todos',
    connectionId: connection.id,
    executedAt: '2026-08-28T00:00:00Z',
    result: {
      data: [
        {
          id: 'project-1',
          code: 'P-01',
          name: 'Pilot',
          client: null,
          status: 'active',
          startDate: null,
          endDate: null,
        },
      ],
      meta: { total: 1 },
    },
  }
}

function remoteFixture(): OryhClientRemote & { readonly calls: string[] } {
  const calls: string[] = []
  const saved = {
    id: savedOperationId('saved-operation-1'),
    connectionId: connection.id,
    operationId: 'my-open-todos' as const,
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
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://oryh.example/web/device',
          verificationUriComplete: 'https://oryh.example/web/device?code=ABCD-EFGH',
          expiresInSeconds: 900,
          pollIntervalSeconds: 5,
        },
      }
    },
    pollConnection: async () => {
      calls.push('pollConnection')
      return { state: 'connected', connection }
    },
    cancelConnection: async () => {
      calls.push('cancelConnection')
    },
    listConnections: async () => {
      calls.push('listConnections')
      return [connection]
    },
    verifyConnection: async () => {
      calls.push('verifyConnection')
      return connection
    },
    listOperations: async () => {
      calls.push('listOperations')
      return [{ id: 'my-open-todos', title: '我的待办', description: '待办', method: 'GET', path: '/projects' }]
    },
    execute: async () => {
      calls.push('execute')
      return projectResult()
    },
    executeOne: async () => {
      calls.push('executeOne')
      return projectResult()
    },
    reuse: async (_connectionId, _operationId, resultId) => {
      calls.push('reuse')
      return projectResult(resultId)
    },
    saveResult: async () => {
      calls.push('saveResult')
      return saved
    },
    listSavedOperations: async () => {
      calls.push('listSavedOperations')
      return [saved]
    },
    refreshSavedOperation: async () => {
      calls.push('refreshSavedOperation')
      return projectResult(operationResultId('result-2'))
    },
    disconnect: async () => {
      calls.push('disconnect')
    },
  }
}

describe('OryhWorkspace', () => {
  it('drives direct operations, cache reuse, and saved refreshes without an AI request', async () => {
    const remote = remoteFixture()
    const workspace = new OryhWorkspace(remote)

    await workspace.load()
    expect(workspace.snapshot().activeConnectionId).toBe(connection.id)

    const first = await workspace.run('my-open-todos')
    expect(first.result.data).toHaveLength(1)
    await workspace.reuse('my-open-todos', first.id)
    await workspace.saveCurrentResult('重点项目')
    await workspace.refreshSavedOperation(savedOperationId('saved-operation-1'))

    expect(remote.calls).toEqual([
      'listConnections',
      'listOperations',
      'verifyConnection',
      'listSavedOperations',
      'execute',
      'reuse',
      'saveResult',
      'listSavedOperations',
      'refreshSavedOperation',
    ])
    expect(remote.calls).not.toContain('askModel')
  })

  it('requires an explicit tenant choice when more than one connection exists', async () => {
    const remote = remoteFixture()
    const second = {
      ...connection,
      id: connectionId('oryh-2'),
      identity: { ...connection.identity, tenant: { ...connection.identity.tenant, id: 'tenant-2' } },
    }
    remote.listConnections = async () => [connection, second]
    const workspace = new OryhWorkspace(remote)

    await workspace.load()
    expect(workspace.snapshot().activeConnectionId).toBeUndefined()
    await expect(workspace.run('my-open-todos')).rejects.toMatchObject<OryhWorkspaceError>({
      code: 'connection-required',
    })

    await workspace.selectConnection(connection.id)
    await expect(workspace.run('my-open-todos')).resolves.toMatchObject({ connectionId: connection.id })
  })

  it('restores the newest grant after the same account was authorized twice', async () => {
    const remote = remoteFixture()
    const latest = { ...connection, id: connectionId('oryh-2'), connectedAt: '2026-08-29T00:00:00Z' }
    remote.listConnections = async () => [latest, connection]
    remote.verifyConnection = async id => (id === latest.id ? latest : connection)
    const workspace = new OryhWorkspace(remote)
    await workspace.load()
    expect(workspace.snapshot().activeConnectionId).toBe(latest.id)
  })

  it('never treats different servers, users, employees or environments as repeated authorization', async () => {
    const identities = [
      { ...connection, origin: 'https://another.example' },
      { ...connection, identity: { ...connection.identity, user: { ...connection.identity.user, id: 'other' } } },
      {
        ...connection,
        identity: { ...connection.identity, user: { ...connection.identity.user, employeeId: 'other' } },
      },
      {
        ...connection,
        identity: { ...connection.identity, tenant: { ...connection.identity.tenant, environmentId: 'other' } },
      },
    ]
    for (const other of identities) {
      const remote = remoteFixture()
      remote.listConnections = async () => [connection, { ...other, id: connectionId('oryh-2') }]
      const workspace = new OryhWorkspace(remote)
      await workspace.load()
      expect(workspace.snapshot().activeConnectionId).toBeUndefined()
    }
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

  it('keeps the active server when loading an authorized replacement fails', async () => {
    const remote = remoteFixture()
    const workspace = new OryhWorkspace(remote)
    await workspace.load()
    const before = workspace.snapshot()
    const replacement = { ...connection, id: connectionId('oryh-new'), origin: 'https://new.oryh.example' }
    remote.pollConnection = async () => ({ state: 'connected', connection: replacement })
    remote.listConnections = async () => [connection, replacement]
    remote.listSavedOperations = async () => {
      throw new Error('Server temporarily unavailable')
    }
    await workspace.beginConnection(replacement.origin, 'ORYH AI Client')
    await expect(workspace.pollConnection()).rejects.toThrow('Server temporarily unavailable')
    expect(workspace.snapshot().activeConnectionId).toBe(connection.id)
    expect(workspace.snapshot().savedOperations).toEqual(before.savedOperations)
    expect(workspace.snapshot().connections).toEqual(before.connections)
  })

  it('does not replace the current server after the person cancels an approved attempt still loading', async () => {
    const remote = remoteFixture()
    const workspace = new OryhWorkspace(remote)
    await workspace.load()
    const replacement = { ...connection, id: connectionId('oryh-new'), origin: 'https://new.oryh.example' }
    remote.pollConnection = async () => ({ state: 'connected', connection: replacement })
    let release!: () => void
    const loading = new Promise<void>(resolve => {
      release = resolve
    })
    remote.listConnections = async () => {
      await loading
      return [connection, replacement]
    }
    await workspace.beginConnection(replacement.origin, 'ORYH AI Client')
    const polling = workspace.pollConnection()
    await Promise.resolve()
    await workspace.cancelConnection()
    release()
    await expect(polling).rejects.toMatchObject({ code: 'stale-request' })
    expect(workspace.snapshot().activeConnectionId).toBe(connection.id)
  })

  it('ends the attempt when the Host refuses the approval, so the page offers a new one instead of waiting', async () => {
    const remote = remoteFixture()
    const cancelled: string[] = []
    remote.pollConnection = async () => {
      throw Object.assign(
        new Error('这是 owner@example.com 的单用户客户端，刚才授权的是 other@example.com，没有连接。'),
        {
          code: 'connection-owner-mismatch',
        },
      )
    }
    remote.cancelConnection = async id => {
      cancelled.push(id)
    }
    const workspace = new OryhWorkspace(remote)
    await workspace.beginConnection('https://oryh.example', 'ORYH AI Client')
    const pending = workspace.snapshot().pendingConnection!
    await expect(workspace.pollConnection()).rejects.toThrow('单用户客户端')
    expect(workspace.snapshot().pendingConnection).toBeUndefined()
    expect(cancelled).toEqual([pending.authorizationId])
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
      'listOperations',
      'verifyConnection',
      'listSavedOperations',
      'disconnect',
      'verifyConnection',
      'listSavedOperations',
    ])
  })
})

it.each(['run', 'reuse', 'refresh'] as const)(
  'discards a late %s result even after switching A to B to A',
  async action => {
    const remote = remoteFixture()
    const second = { ...connection, id: connectionId('oryh-2'), origin: 'https://another.example' }
    remote.listConnections = async () => [connection, second]
    remote.verifyConnection = async id => (id === connection.id ? connection : second)
    let release: (value: OryhOperationResult) => void = () => {
      throw new Error('Request not started')
    }
    const delayed = () =>
      new Promise<OryhOperationResult>(resolve => {
        release = resolve
      })
    remote.execute = delayed
    remote.reuse = delayed
    remote.refreshSavedOperation = delayed
    const workspace = new OryhWorkspace(remote)
    await workspace.load()
    await workspace.selectConnection(connection.id)
    const pending =
      action === 'run'
        ? workspace.run('my-open-todos')
        : action === 'reuse'
          ? workspace.reuse('my-open-todos', operationResultId('result-1'))
          : workspace.refreshSavedOperation(savedOperationId('saved-operation-1'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'stale-request' })
    await workspace.selectConnection(second.id)
    await workspace.selectConnection(connection.id)
    release(projectResult())
    await rejected
    expect(workspace.snapshot().currentResult).toBeUndefined()
  },
)

it('clears the active enterprise and cached views when selection verification fails', async () => {
  const remote = remoteFixture()
  const second = { ...connection, id: connectionId('oryh-2'), origin: 'https://another.example' }
  remote.listConnections = async () => [connection, second]
  const workspace = new OryhWorkspace(remote)
  await workspace.load()
  await workspace.selectConnection(connection.id)
  await workspace.run('my-open-todos')
  remote.verifyConnection = async () => {
    throw new Error('Verification failed')
  }
  await expect(workspace.selectConnection(second.id)).rejects.toThrow('Verification failed')
  expect(workspace.snapshot()).toMatchObject({
    activeConnectionId: undefined,
    currentResult: undefined,
    savedOperations: [],
  })
  await expect(workspace.run('my-open-todos')).rejects.toMatchObject({ code: 'connection-required' })
})

it('does not publish an earlier enterprise selection that finishes last', async () => {
  const remote = remoteFixture()
  const second = { ...connection, id: connectionId('oryh-2'), origin: 'https://another.example' }
  remote.listConnections = async () => [connection, second]
  let release: (value: typeof connection) => void = () => {
    throw new Error('Verification not started')
  }
  remote.verifyConnection = async id =>
    id === second.id
      ? second
      : new Promise(resolve => {
          release = resolve
        })
  const workspace = new OryhWorkspace(remote)
  await workspace.load()
  const first = workspace.selectConnection(connection.id)
  const rejected = expect(first).rejects.toMatchObject({ code: 'stale-request' })
  await workspace.selectConnection(second.id)
  release(connection)
  await rejected
  expect(workspace.snapshot().activeConnectionId).toBe(second.id)
})

it('switches the native Profile before publishing another connection and preserves the current account on cancellation', async () => {
  const original = remoteFixture()
  let ready = true
  const remote = { ...original, activateProfile: async () => ready }
  const workspace = new OryhWorkspace(remote)
  await workspace.load()
  const result = await workspace.run('my-open-todos')
  ready = false
  await expect(workspace.selectConnection(connection.id)).rejects.toMatchObject({ code: 'profile-switch-pending' })
  expect(workspace.snapshot().activeConnectionId).toBe(connection.id)
  expect(workspace.snapshot().currentResult).toEqual(result)
})

it('does not publish an authorized new account while its old Harness Profile is still open', async () => {
  const original = remoteFixture()
  const remote = { ...original, activateProfile: async () => false }
  const workspace = new OryhWorkspace(remote)
  await workspace.beginConnection(connection.origin, 'Test')
  await expect(workspace.pollConnection()).rejects.toMatchObject({ code: 'profile-switch-pending' })
  expect(workspace.snapshot().activeConnectionId).toBeUndefined()
})

it('restores the native selected account when several identities are saved', async () => {
  const remote = remoteFixture()
  const second = { ...connection, id: connectionId('oryh-2'), origin: 'https://another.example' }
  remote.listConnections = async () => [connection, second]
  remote.verifyConnection = async id => (id === second.id ? second : connection)
  const activations: string[] = []
  remote.activateProfile = async id => {
    activations.push(id)
    return true
  }
  const workspace = new OryhWorkspace(remote)
  await workspace.load(second.id)
  expect(workspace.snapshot().activeConnectionId).toBe(second.id)
  expect(activations).toEqual([second.id])
})
