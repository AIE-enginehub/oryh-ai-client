import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AttachmentUploader,
  ConnectionRegistry,
  type DelegatedResponse,
  MAX_ATTACHMENT_BYTES,
  MemoryCredentialVault,
  OryhHttpClient,
  type OryhRequest,
  operationDigest,
} from '../src/index.js'

const identity = {
  permissions: ['expense.submit_own'],
  user: { id: 'user-1', email: 'a@example.com', name: null, role: 'member', employeeId: 'employee-1' },
  tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme', environmentId: null },
}

/** An uploader over a delegated transport that answers each upload with the given status. */
function setup(
  status: (sent: number) => number,
  sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex'),
) {
  const connections = new ConnectionRegistry()
  const connection = connections.add({ origin: 'https://oryh.example', identity })
  connections.markVerified(connection.id, identity)
  const sent: OryhRequest[] = []
  const http = new OryhHttpClient(
    connections,
    new MemoryCredentialVault(),
    async () => {
      throw new Error('not over the network')
    },
    {
      delegated: {
        signal: new AbortController().signal,
        send: async (request): Promise<DelegatedResponse> => {
          sent.push(request)
          const body = request.body as { filename: string; content_base64: string }
          const bytes = Buffer.from(body.content_base64, 'base64')
          return {
            status: status(sent.length),
            body: { data: { id: 'att-1', filename: body.filename, sha256: sha(bytes) } },
          }
        },
      },
    },
  )
  const verified: string[] = []
  const uploader = new AttachmentUploader(http, async id => {
    verified.push(id)
  })
  return { uploader, connection, sent, verified }
}

describe('AttachmentUploader', () => {
  const receipt = { filename: '发票.pdf', contentType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }

  it('files the bytes as a page write, and reads 200 as a file ORYH already held', async () => {
    const f = setup(sent => (sent === 1 ? 201 : 200))
    const first = await f.uploader.upload(f.connection.id, receipt)
    expect(first).toEqual({
      id: 'att-1',
      filename: '发票.pdf',
      sha256: createHash('sha256').update(receipt.data).digest('hex'),
      sizeBytes: 4,
      alreadyExisted: false,
    })
    expect((await f.uploader.upload(f.connection.id, receipt)).alreadyExisted).toBe(true)
    const [request] = f.sent
    expect(request).toMatchObject({
      method: 'POST',
      path: '/attachments',
      body: { filename: '发票.pdf', content_type: 'application/pdf', content_base64: 'JVBERg==' },
    })
    // Choosing the file is the confirmation: the control process checks this digest before it sends.
    expect(request!.operation).toMatchObject({
      kind: 'page',
      digest: operationDigest({ method: 'POST', path: '/attachments', body: request!.body }),
    })
    expect(f.sent[0]!.operation!.operationId).not.toBe(f.sent[1]!.operation!.operationId)
    expect(f.verified).toEqual([f.connection.id, f.connection.id])
  })

  it('refuses what ORYH would refuse before sending, and a receipt for other bytes', async () => {
    const f = setup(() => 201)
    await expect(f.uploader.upload(f.connection.id, { ...receipt, data: new Uint8Array() })).rejects.toThrow('空文件')
    await expect(
      f.uploader.upload(f.connection.id, { ...receipt, data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) }),
    ).rejects.toThrow('超过 ORYH 附件 10 MB 的上限')
    expect(f.sent).toEqual([])
    const wrong = setup(
      () => 201,
      () => 'other',
    )
    await expect(wrong.uploader.upload(wrong.connection.id, receipt)).rejects.toThrow('无法核对')
  })
})

it('accepts exactly 10 MB and explains a remote 413 without repeating untrusted detail', async () => {
  const f = setup(() => 201)
  await expect(
    f.uploader.upload(f.connection.id, {
      filename: 'boundary.pdf',
      contentType: 'application/pdf',
      data: new Uint8Array(MAX_ATTACHMENT_BYTES),
    }),
  ).resolves.toMatchObject({ sizeBytes: MAX_ATTACHMENT_BYTES })
  const rejected = setup(() => 413)
  await expect(
    rejected.uploader.upload(rejected.connection.id, {
      filename: 'small.pdf',
      contentType: 'application/pdf',
      data: new Uint8Array([1]),
    }),
  ).rejects.toMatchObject({ status: 413, message: expect.stringContaining('服务端或网关拒绝') })
})

it('reports an HTML gateway 413 as an upload size refusal instead of an authorization failure', async () => {
  const registry = new ConnectionRegistry()
  const connection = registry.add({ origin: 'https://oryh.example', identity })
  registry.markVerified(connection.id, identity)
  const credentials = new MemoryCredentialVault()
  await credentials.write(connection.id, { accessKey: 'test-key', refreshToken: 'test-refresh', expiresAt: null })
  const http = new OryhHttpClient(registry, credentials, async () => ({
    ok: false,
    status: 413,
    json: async () => {
      throw new SyntaxError('private gateway detail')
    },
  }))
  const uploader = new AttachmentUploader(http, async () => {})
  await expect(
    uploader.upload(connection.id, {
      filename: 'small.pdf',
      contentType: 'application/pdf',
      data: new Uint8Array([1]),
    }),
  ).rejects.toMatchObject({ status: 413, code: 'request-failed', message: expect.stringContaining('上传链路限制') })
})
