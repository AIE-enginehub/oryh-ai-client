import { createHash, randomUUID } from 'node:crypto'
import type { ConnectionId } from './brand.js'
import { OryhClientError } from './errors.js'
import type { OryhHttpClient } from './http.js'
import { pageOperation } from './server-operation.js'

/** ORYH's limit on one attachment; checked here so a person hears the size, not an HTTP 413. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** One file to store, as the person chose it. */
export interface AttachmentFile {
  readonly filename: string
  readonly contentType: string
  readonly data: Uint8Array
}

/** What ORYH stored, in the shape its own upload script reports. */
export interface UploadedAttachment {
  readonly id: string
  readonly filename: string
  readonly sha256: string
  readonly sizeBytes: number
  /** ORYH already held these exact bytes (200, not 201): this file was uploaded before. */
  readonly alreadyExisted: boolean
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hashText = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * Stores a file the person chose as an ORYH attachment: the evidence a document links by id.
 *
 * The bytes are always the person's own file, read by Host code — never content a model wrote. Choosing
 * the file is the confirmation, as it is for a page's file picker (docs/34 §6), so the upload goes as a
 * page write; it creates no business fact, only a file nothing links to yet. ORYH keeps one copy per
 * content, so sending the same file twice stores it once.
 */
export class AttachmentUploader {
  constructor(
    private readonly http: OryhHttpClient,
    private readonly verify: (id: ConnectionId) => Promise<unknown>,
  ) {}

  /**
   * @param connectionId - the enterprise the file is filed with.
   * @param file - the person's file, byte for byte.
   * @returns ORYH's attachment, checked against the bytes sent.
   */
  async upload(connectionId: ConnectionId, file: AttachmentFile): Promise<UploadedAttachment> {
    const size = file.data.byteLength
    if (size === 0) throw new OryhClientError(`${file.filename} 是空文件。`, 'request-failed')
    if (size > MAX_ATTACHMENT_BYTES)
      throw new OryhClientError(
        `${file.filename} 有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ORYH 附件 10 MB 的上限。`,
        'request-failed',
      )
    await this.verify(connectionId)
    const sha256 = createHash('sha256').update(file.data).digest('hex')
    const upload = {
      path: '/attachments' as const,
      method: 'POST' as const,
      body: {
        filename: file.filename.slice(0, 255),
        content_type: file.contentType,
        content_base64: Buffer.from(file.data).toString('base64'),
      },
    }
    const answer = await this.http.exchange(connectionId, {
      ...upload,
      operation: pageOperation(randomUUID(), upload, hashText),
    })
    const data = isObject(answer.body) && isObject(answer.body.data) ? answer.body.data : {}
    if (typeof data.id !== 'string' || data.sha256 !== sha256)
      throw new OryhClientError('附件上传回执无法核对。', 'invalid-response')
    return {
      id: data.id,
      filename: typeof data.filename === 'string' ? data.filename : upload.body.filename,
      sha256,
      sizeBytes: size,
      alreadyExisted: answer.status === 200,
    }
  }
}
