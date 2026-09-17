import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EncryptedExpenseStore,
  type ExpenseFields,
  ExpenseService,
  type ExpenseStore,
  MemoryExpenseStore,
} from '@oryh/ai-client-expenses'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionRegistry, MemoryCredentialVault, OryhHttpClient } from '../src/index.js'
import { jsonResponse } from './fixtures.js'

const fields: ExpenseFields = {
  title: '客户拜访交通费',
  claimDate: '2026-09-08',
  currency: 'CNY',
  items: [
    {
      expenseDate: '2026-09-08',
      category: 'travel',
      amount: '12.50',
      merchant: '测试商户',
      invoiceNumber: 'TEST-INVOICE',
      notes: '往返车费',
    },
  ],
}
function setup(store: ExpenseStore = new MemoryExpenseStore()) {
  const registry = new ConnectionRegistry()
  const connection = registry.add({
    origin: 'https://oryh.example',
    identity: {
      permissions: [
        'master_data.manage',
        'expense.submit_own',
        'timesheet.submit_own',
        'approval.record',
        'order.submit_own',
        'inventory.manage',
      ],
      user: { id: 'user', email: 'test@example.invalid', name: 'Test', employeeId: 'employee', role: 'member' },
      tenant: { id: 'tenant', slug: 'tenant', name: 'Tenant', environmentId: null },
    },
  })
  registry.markVerified(connection.id, connection.identity)
  const claims: Array<Record<string, unknown>> = []
  const items: Array<Record<string, unknown>[]> = []
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  let loseCreateResponse = false
  let loseSubmitResponse = false
  let dryRunSupported = true
  let rejectCreate = false
  const credentials = new MemoryCredentialVault()
  const http = new OryhHttpClient(registry, credentials, async (input, init) => {
    const path = new URL(input).pathname + new URL(input).search
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const method = init?.method ?? 'GET'
    calls.push({ path, method, body })
    if (path.includes('validate_only'))
      return jsonResponse(200, {
        data: { id: 'dry-run-only' },
        meta: dryRunSupported ? { validate_only: true, written: false } : {},
      })
    if (path === '/api/v1/expense-claims' && method === 'POST') {
      if (rejectCreate) return jsonResponse(422, { detail: 'Invalid field' })
      const claim = { ...body, id: `claim-${claims.length + 1}`, submitted_at: null, status: 'brouillon' }
      claims.push(claim)
      items.push(body.items as Record<string, unknown>[])
      if (loseCreateResponse) throw new Error('Connection lost after commit')
      return jsonResponse(201, { data: claim })
    }
    if (path.startsWith('/api/v1/expense-claims?'))
      return jsonResponse(200, { data: claims, meta: { total: claims.length, pages: 1 } })
    if (path.endsWith('/detail')) {
      const index = claims.findIndex(row => path.includes(`/${row.id}/`))
      return jsonResponse(200, { data: { claim: claims[index], items: items[index], attachments: [] } })
    }
    if (path.endsWith('/submit')) {
      const claim = claims.find(row => path.includes(`/${row.id}/`))!
      claim.submitted_at = '2026-09-08T00:00:00Z'
      claim.status = 'en-attente'
      if (loseSubmitResponse) throw new Error('Submission response lost')
      return jsonResponse(200, { data: claim })
    }
    if (path === '/api/v1/attachments')
      return jsonResponse(201, {
        data: {
          id: 'attachment',
          filename: body.filename,
          sha256: createHash('sha256')
            .update(Buffer.from(String(body.content_base64), 'base64'))
            .digest('hex'),
        },
      })
    if (path.startsWith('/api/v1/type-options')) return jsonResponse(200, { data: [{ name: 'travel', title: '差旅' }] })
    throw new Error(`Unexpected request: ${path}`)
  })
  const service = new ExpenseService(
    store,
    http,
    id => registry.requireVerified(id as typeof connection.id),
    async id => registry.requireVerified(id as typeof connection.id),
  )
  return {
    service,
    claims,
    items,
    calls,
    connection,
    registry,
    initialize: () =>
      credentials.write(connection.id, { accessKey: 'synthetic', refreshToken: 'synthetic', expiresAt: null }),
    loseCreate: () => {
      loseCreateResponse = true
    },
    loseSubmit: () => {
      loseSubmitResponse = true
    },
    noDryRun: () => {
      dryRunSupported = false
    },
    rejectCreate: () => {
      rejectCreate = true
    },
    recreate: () =>
      new ExpenseService(
        store,
        http,
        id => registry.requireVerified(id as typeof connection.id),
        async id => registry.requireVerified(id as typeof connection.id),
      ),
  }
}
async function reviewed(fixture: ReturnType<typeof setup>) {
  await fixture.initialize()
  const draft = await fixture.service.expenseSave(fixture.connection.id, { fields })
  return fixture.service.expensePrepare(fixture.connection.id, draft.id, draft.revision)
}

describe('expense workflow', () => {
  it('validates without creating and separately confirms creation and official submission', async () => {
    const fixture = setup()
    const draft = await reviewed(fixture)
    expect(fixture.claims).toHaveLength(0)
    expect(draft.claimId).toBeUndefined()
    const created = await fixture.service.expenseConfirm(
      fixture.connection.id,
      draft.id,
      draft.revision,
      draft.confirmation!.token,
    )
    expect(created.state).toBe('created')
    expect(created.serverStatus).toBe('brouillon')
    const review = await fixture.service.expensePrepare(fixture.connection.id, created.id, created.revision)
    expect(fixture.claims[0]!.submitted_at).toBeNull()
    const submitted = await fixture.service.expenseConfirm(
      fixture.connection.id,
      review.id,
      review.revision,
      review.confirmation!.token,
    )
    expect(submitted.state).toBe('submitted')
    expect(submitted.serverStatus).toBe('en-attente')
    expect(fixture.calls.find(call => call.path === '/api/v1/expense-claims')!.body).toMatchObject({
      employee_id: 'employee',
      items: [{ amount: 12.5 }],
    })
    expect(fixture.calls.find(call => call.path === '/api/v1/expense-claims')!.body).not.toHaveProperty('status')
  })

  it('invalidates prior confirmations after editing and refuses concurrent duplicate creation', async () => {
    const fixture = setup()
    const first = await reviewed(fixture)
    const edited = await fixture.service.expenseSave(fixture.connection.id, {
      id: first.id,
      revision: first.revision,
      fields: { ...fields, title: '修订标题' },
    })
    await expect(
      fixture.service.expenseConfirm(fixture.connection.id, edited.id, edited.revision, first.confirmation!.token),
    ).rejects.toThrow('确认已失效')
    const review = await fixture.service.expensePrepare(fixture.connection.id, edited.id, edited.revision)
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        fixture.service.expenseConfirm(fixture.connection.id, review.id, review.revision, review.confirmation!.token),
      ),
    )
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(fixture.claims).toHaveLength(1)
  })

  it('recovers a lost creation receipt after recreating the service without another POST', async () => {
    const fixture = setup()
    const review = await reviewed(fixture)
    fixture.loseCreate()
    const unknown = await fixture.service.expenseConfirm(
      fixture.connection.id,
      review.id,
      review.revision,
      review.confirmation!.token,
    )
    expect(unknown.state).toBe('unknown-create')
    const restarted = fixture.recreate()
    const restored = (await restarted.expenseList(fixture.connection.id))[0]!
    const recovered = await restarted.expenseReconcile(fixture.connection.id, restored.id, restored.revision)
    expect(recovered).toMatchObject({ state: 'created', claimId: 'claim-1' })
    expect(fixture.calls.filter(call => call.path === '/api/v1/expense-claims')).toHaveLength(1)
  })

  it('recovers a lost submission response from server facts', async () => {
    const fixture = setup()
    const initial = await reviewed(fixture)
    const created = await fixture.service.expenseConfirm(
      fixture.connection.id,
      initial.id,
      initial.revision,
      initial.confirmation!.token,
    )
    const review = await fixture.service.expensePrepare(fixture.connection.id, created.id, created.revision)
    fixture.loseSubmit()
    const unknown = await fixture.service.expenseConfirm(
      fixture.connection.id,
      review.id,
      review.revision,
      review.confirmation!.token,
    )
    expect(unknown.state).toBe('unknown-submit')
    const recovered = await fixture.service.expenseReconcile(fixture.connection.id, unknown.id, unknown.revision)
    expect(recovered.state).toBe('submitted')
    expect(fixture.calls.filter(call => call.path.endsWith('/submit'))).toHaveLength(1)
  })

  it('refuses submission after the server changes the reviewed content', async () => {
    const fixture = setup()
    const initial = await reviewed(fixture)
    const created = await fixture.service.expenseConfirm(
      fixture.connection.id,
      initial.id,
      initial.revision,
      initial.confirmation!.token,
    )
    const review = await fixture.service.expensePrepare(fixture.connection.id, created.id, created.revision)
    fixture.items[0]![0]!.amount = 999
    await expect(
      fixture.service.expenseConfirm(fixture.connection.id, review.id, review.revision, review.confirmation!.token),
    ).rejects.toThrow('原确认已失效')
    expect(fixture.calls.filter(call => call.path.endsWith('/submit'))).toHaveLength(0)
  })

  it('requires an explicit dry-run receipt and does not retry a rejected create', async () => {
    const fixture = setup()
    await fixture.initialize()
    const draft = await fixture.service.expenseSave(fixture.connection.id, { fields })
    fixture.noDryRun()
    await expect(fixture.service.expensePrepare(fixture.connection.id, draft.id, draft.revision)).rejects.toThrow(
      '仅校验模式',
    )
    const other = setup()
    const review = await reviewed(other)
    other.rejectCreate()
    expect(
      (await other.service.expenseConfirm(other.connection.id, review.id, review.revision, review.confirmation!.token))
        .state,
    ).toBe('editing')
    expect(other.calls.filter(call => call.path === '/api/v1/expense-claims')).toHaveLength(1)
  })

  it('binds stored drafts to origin, tenant, user and employee rather than a reusable local connection number', async () => {
    const store = new MemoryExpenseStore()
    const fixture = setup(store)
    const review = await reviewed(fixture)
    fixture.registry.markVerified(fixture.connection.id, {
      ...fixture.connection.identity,
      user: { ...fixture.connection.identity.user, id: 'other-user' },
    })
    expect(await fixture.service.expenseList(fixture.connection.id)).toEqual([])
    await expect(
      fixture.service.expenseConfirm(fixture.connection.id, review.id, review.revision, review.confirmation!.token),
    ).rejects.toThrow('不可用')
    expect(fixture.claims).toHaveLength(0)
  })

  it('accepts only upload receipts issued in the same scope or retained in a saved draft', async () => {
    const fixture = setup()
    await fixture.initialize()
    const attachment = { id: 'stolen-id', filename: 'secret.pdf', sha256: 'x'.repeat(64) }
    await expect(
      fixture.service.expenseSave(fixture.connection.id, {
        fields: { ...fields, items: [{ ...fields.items[0]!, attachment }] },
      }),
    ).rejects.toThrow('上传入口')
    const receipt = await fixture.service.expenseUpload(fixture.connection.id, {
      filename: 'receipt.pdf',
      contentType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-test').toString('base64'),
    })
    const draft = await fixture.service.expenseSave(fixture.connection.id, {
      fields: { ...fields, items: [{ ...fields.items[0]!, attachment: receipt }] },
    })
    expect(
      (
        await fixture
          .recreate()
          .expenseSave(fixture.connection.id, { id: draft.id, revision: draft.revision, fields: draft.fields })
      ).fields.items[0]!.attachment,
    ).toEqual(receipt)
  })
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
it('encrypts durable drafts and refuses a damaged newest revision rather than falling back to an executable confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oryh-expenses-'))
  directories.push(directory)
  const key = randomBytes(32)
  const store = new EncryptedExpenseStore(directory, async () => key)
  const fixture = setup(store)
  const review = await reviewed(fixture)
  const fileNames = await readdir(directory)
  for (const file of fileNames)
    expect((await readFile(join(directory, file))).includes(Buffer.from(fields.title))).toBe(false)
  const latest = join(directory, `${review.id}.${review.revision}.enc`)
  await writeFile(latest, Buffer.from('interrupted write'))
  await expect(fixture.recreate().expenseList(fixture.connection.id)).rejects.toThrow('不完整或无法解密')
  expect(fixture.claims).toHaveLength(0)
})

it('leaves an ambiguous creation unresolved and never sends another create', async () => {
  const fixture = setup()
  const review = await reviewed(fixture)
  fixture.loseCreate()
  const unknown = await fixture.service.expenseConfirm(
    fixture.connection.id,
    review.id,
    review.revision,
    review.confirmation!.token,
  )
  fixture.claims.push({ ...fixture.claims[0], id: 'duplicate' })
  await expect(fixture.service.expenseReconcile(fixture.connection.id, unknown.id, unknown.revision)).rejects.toThrow(
    '唯一定位',
  )
  expect((await fixture.service.expenseList(fixture.connection.id))[0]!.state).toBe('unknown-create')
  await expect(
    fixture.service.expenseConfirm(fixture.connection.id, unknown.id, unknown.revision, review.confirmation!.token),
  ).rejects.toThrow('确认已失效')
  expect(fixture.calls.filter(call => call.path === '/api/v1/expense-claims')).toHaveLength(1)
})

it('rejects expired confirmation and exposes an interrupted durable intent only as an unknown result', async () => {
  const store = new MemoryExpenseStore()
  const fixture = setup(store)
  const review = await reviewed(fixture)
  const saved = (await store.list())[0]!
  await store.append(
    {
      ...saved,
      revision: saved.revision + 1,
      confirmation: { ...saved.confirmation!, expiresAt: '2020-01-01T00:00:00Z' },
    },
    saved.revision,
  )
  await expect(
    fixture.service.expenseConfirm(fixture.connection.id, review.id, review.revision + 1, review.confirmation!.token),
  ).rejects.toThrow('确认已失效')
  const expired = (await store.list())[0]!
  await store.append(
    { ...expired, revision: expired.revision + 1, state: 'creating', confirmation: undefined },
    expired.revision,
  )
  expect((await fixture.recreate().expenseList(fixture.connection.id))[0]!.state).toBe('unknown-create')
  expect(fixture.claims).toHaveLength(0)
})

it('allows only one writer to append a particular encrypted revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oryh-expense-cas-'))
  directories.push(directory)
  const key = randomBytes(32)
  const first = new EncryptedExpenseStore(directory, async () => key)
  const second = new EncryptedExpenseStore(directory, async () => key)
  const fixture = setup(first)
  await reviewed(fixture)
  const record = (await first.list())[0]!
  const next = { ...record, revision: record.revision + 1, state: 'creating' as const }
  const attempts = await Promise.allSettled([first.append(next, record.revision), second.append(next, record.revision)])
  expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
  expect((await first.list())[0]!.state).toBe('creating')
})

it('saves incomplete local work without permitting validation or any remote creation', async () => {
  const fixture = setup()
  await fixture.initialize()
  const draft = await fixture.service.expenseSave(fixture.connection.id, {
    fields: {
      title: '',
      currency: 'CNY',
      claimDate: '',
      items: [{ ...fields.items[0]!, expenseDate: '', category: '', amount: '' }],
    },
  })
  expect(draft.fields.title).toBe('')
  await expect(fixture.service.expensePrepare(fixture.connection.id, draft.id, draft.revision)).rejects.toThrow()
  expect(fixture.calls).toEqual([])
})
