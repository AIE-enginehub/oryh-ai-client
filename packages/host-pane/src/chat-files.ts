/**
 * Files the person attached in Chat, found in the conversation and filed with ORYH.
 *
 * A model cannot hand over a file's bytes: a photo is megabytes, and nobody could tell whether what
 * arrived is the file the person chose (docs/34 §6). So a tool takes a reference instead — the file's
 * name or `sha256:` prefix as the conversation shows it — and the Host reads the stored bytes and
 * uploads them. `upload_attachment` does that for any document; a page's own tool does it for the form
 * it fills, such as a receipt on an expense line (docs/52).
 */
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { type AttachmentUploader, MAX_ATTACHMENT_BYTES, type UploadedAttachment } from '@oryh/ai-client-core'
import { type ConnectionId, OryhClientError } from '@oryh/ai-client-foundation'

/** The client's own upload tool, whose results say what a session filed with ORYH. */
export const UPLOAD_TOOL = 'upload_attachment'

/** Where the Host keeps what was attached: read by the reference in the conversation, never by a path. */
export interface ChatFiles {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>
  readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/**
 * The part of a conversation these helpers read: what each message is, who sent it, and its blocks. A
 * tool's result is a message of its own in the tool role, naming the call it answers (DSH 0.1.7, session
 * format V4); before that it was a `tool-result` block inside a user message.
 */
export interface Conversation {
  deriveMessages(): readonly {
    readonly role: string
    readonly source: { readonly kind: string }
    readonly toolCallId?: unknown
    readonly isError?: unknown
    readonly content: readonly {
      readonly type: string
      readonly attachment?: unknown
      readonly id?: unknown
      readonly name?: unknown
      readonly text?: unknown
    }[]
  }[]
}

/** One file the person attached: a picture, or any other file kept as it was. */
export type ChatFile =
  | { readonly kind: 'image'; readonly ref: ImageAttachmentRef }
  | { readonly kind: 'file'; readonly ref: FileAttachmentRef }

/**
 * What this session filed with ORYH through `upload_attachment`, read back from its own results: the id
 * ORYH gave each file, under the name it was filed as, with the digest the upload was checked against.
 * @param conversation - the session.
 * @returns every file uploaded, once, in the order it was first filed.
 */
export function uploadedAttachments(conversation: Conversation): { file: string; id: string; sha256?: string }[] {
  const calls = new Set<unknown>()
  const found = new Map<string, { file: string; id: string; sha256?: string }>()
  for (const message of conversation.deriveMessages()) {
    for (const block of message.content)
      if (block.type === 'tool-call' && block.name === UPLOAD_TOOL) calls.add(block.id)
    if (message.role !== 'tool' || message.isError === true || !calls.has(message.toolCallId)) continue
    const text = message.content.map(part => (typeof part.text === 'string' ? part.text : '')).join('')
    let results: unknown
    try {
      results = JSON.parse(text)
    } catch {
      continue
    }
    for (const result of Array.isArray(results) ? results : [])
      if (typeof result?.id === 'string' && typeof result?.file === 'string' && !found.has(result.id))
        found.set(result.id, {
          file: result.file,
          id: result.id,
          ...(typeof result.sha256 === 'string' ? { sha256: result.sha256 } : {}),
        })
  }
  return [...found.values()]
}

const TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  ofd: 'application/ofd',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
}
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const extensionOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase()
/** The file's content digest, as the conversation shows its prefix. */
export const digestOf = (file: ChatFile) => String(file.ref.attachmentId).replace(/^sha256:/, '')

/**
 * What the person attached, in order, once each. A message a plugin or a tool put in the conversation
 * does not count: only a file the person chose is theirs to file.
 */
export function attachedFiles(conversation: Conversation): ChatFile[] {
  const seen = new Map<string, ChatFile>()
  for (const message of conversation.deriveMessages()) {
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    for (const block of message.content) {
      const attached: ChatFile | undefined =
        block.type === 'image'
          ? { kind: 'image', ref: block.attachment as ImageAttachmentRef }
          : block.type === 'file'
            ? { kind: 'file', ref: block.attachment as FileAttachmentRef }
            : undefined
      if (attached && !seen.has(String(attached.ref.attachmentId)))
        seen.set(String(attached.ref.attachmentId), attached)
    }
  }
  return [...seen.values()]
}

/**
 * The file a name or `sha256:` prefix means, or why none is.
 * @param attached - what the person attached in this session.
 * @param wanted - the reference the model gave.
 * @returns the one file it names, or the reason in words the model acts on.
 */
export function pickChatFile(attached: readonly ChatFile[], wanted: string): ChatFile | string {
  const key = wanted.trim()
  const hex = key.replace(/^sha256:/i, '').toLowerCase()
  const matches = /^[0-9a-f]{8,64}$/.test(hex)
    ? attached.filter(file => digestOf(file).startsWith(hex))
    : attached.filter(file => file.ref.name === key)
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) return `「${key}」对应多个附件，请改用 sha256 前缀指定。`
  return `本会话里没有找到用户附上的「${key}」。`
}

/**
 * The file's name and type as ORYH will keep them. A picture is kept as the Host stored it, which may
 * be re-encoded; its name keeps the person's unless the extension no longer says what it is.
 */
export function describeChatFile(attached: ChatFile): { filename: string; contentType: string } {
  if (attached.kind === 'file') {
    const name = attached.ref.name
    return { filename: name, contentType: TYPES[extensionOf(name) ?? ''] ?? 'application/octet-stream' }
  }
  const { mediaType, name } = attached.ref
  if (name && TYPES[extensionOf(name) ?? ''] === mediaType) return { filename: name, contentType: mediaType }
  const base = name?.replace(/\.[A-Za-z0-9]+$/, '') || `image-${digestOf(attached).slice(0, 8)}`
  return { filename: `${base}.${EXTENSIONS[mediaType] ?? 'bin'}`, contentType: mediaType }
}

/**
 * The bytes of one attached file, as the Host stored them.
 * @param files - where the Host keeps what the person attached.
 * @param attached - the file.
 * @param signal - the tool call's cancellation.
 */
export async function bytesOf(files: ChatFiles, attached: ChatFile, signal: AbortSignal): Promise<Uint8Array> {
  if (attached.kind === 'image') return (await files.readImage(attached.ref, signal)).data
  const chunks: Uint8Array[] = []
  for await (const chunk of files.readFileStream(attached.ref, signal)) chunks.push(chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * File one attached file with ORYH, as the person's own upload.
 *
 * The stored size is known before any byte is read: a file ORYH would refuse is not read at all.
 * @param options.files - where the Host keeps what the person attached.
 * @param options.uploader - files one file with ORYH.
 * @param connectionId - the enterprise the session writes to.
 * @param attached - the file.
 * @param signal - the tool call's cancellation.
 * @returns ORYH's attachment, under the name it was filed as.
 * @throws when the file is over ORYH's limit or the upload fails.
 */
export async function fileChatFile(
  options: { readonly files: ChatFiles; readonly uploader: Pick<AttachmentUploader, 'upload'> },
  connectionId: ConnectionId,
  attached: ChatFile,
  signal: AbortSignal,
): Promise<UploadedAttachment & { readonly file: string }> {
  const { filename, contentType } = describeChatFile(attached)
  if (attached.ref.bytes > MAX_ATTACHMENT_BYTES) {
    const size = (attached.ref.bytes / 1024 / 1024).toFixed(1)
    throw new OryhClientError(`${filename} 有 ${size} MB，超过 ORYH 附件 10 MB 的上限。`, 'request-failed')
  }
  const data = await bytesOf(options.files, attached, signal)
  const stored = await options.uploader.upload(connectionId, { filename, contentType, data })
  return { ...stored, file: filename }
}
