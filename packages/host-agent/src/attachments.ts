/**
 * Files the person attached in Chat, filed with ORYH as the attachments its documents link to.
 *
 * ORYH's own `upload_attachment` takes the file as base64 in the call, which from Chat means the model
 * writing out bytes: impossible for a photo, and nobody could tell whether what arrived is the file the
 * person chose (docs/34 §6). This tool takes its name, so ORYH's is not offered, and takes a reference
 * instead: the model names one of the files the person attached, and the Host reads that file's stored
 * bytes and uploads them. A skill that says "upload with upload_attachment" reaches this tool.
 *
 * Finding and filing the file is shared with the pages' own tools, so it lives in the pane package.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AttachmentUploader } from '@oryh/ai-client-core'
import { type ConnectionId, OryhClientError } from '@oryh/ai-client-foundation'
import {
  attachedFiles,
  type ChatFiles,
  describeChatFile,
  fileChatFile,
  pickChatFile,
  textOutput,
  UPLOAD_TOOL,
} from '@oryh/dsh-pane'

export { type ChatFiles, type Conversation, UPLOAD_TOOL, uploadedAttachments } from '@oryh/dsh-pane'

/**
 * The tool, over the Host's stored attachments and the ORYH connection a session writes to.
 * @param options.files - where the Host keeps what the person attached.
 * @param options.uploader - files one file with ORYH.
 * @param options.connectionOf - the enterprise a session's writes go to.
 */
export function uploadTool(options: {
  readonly files: ChatFiles
  readonly uploader: Pick<AttachmentUploader, 'upload'>
  readonly connectionOf: (sessionId: string) => Promise<ConnectionId>
}) {
  return defineTool({
    name: UPLOAD_TOOL,
    description:
      '把用户在本会话里附上的文件（发票、收据照片、合同原件等）上传为 ORYH 附件，返回 attachment_id，供单据引用（例如报销明细的 attachment_id）。' +
      'files 填对话里文件标注的 sha256 前缀（如 sha256:1a2b3c4d）或文件名；文件内容由客户端从用户附上的原件读取，不要自己编码 base64。' +
      '返回每个文件的 id、sha256、size_bytes、already_existed；already_existed 为 true 表示 ORYH 早已存有同一文件，登记单据前先告诉用户。' +
      '用户还没附上文件时，请对方在对话框里附上。',
    parameters: {
      files: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '要上传的附件：sha256 前缀或文件名，一次可传多个。',
      },
    },
    output: textOutput,
    execute: async (args, exec) => {
      if (!exec.agent) throw new OryhClientError('需要会话。', 'request-failed')
      const wanted = args.files
      if (wanted.length === 0 || wanted.length > 20)
        throw new OryhClientError('files 须列出 1 到 20 个文件名或 sha256 前缀。', 'request-failed')
      const attached = attachedFiles(exec.agent.session)
      if (attached.length === 0)
        throw new OryhClientError(
          '本会话里用户还没有附上文件。请对方在对话框里附上文件（点附件按钮或把文件拖进来），再上传。',
          'request-failed',
        )
      const connectionId = await options.connectionOf(String(exec.agent.id))
      const results: Record<string, unknown>[] = []
      for (const item of wanted) {
        exec.signal.throwIfAborted()
        const file = pickChatFile(attached, item)
        if (typeof file === 'string') {
          results.push({ file: item, error: file })
          continue
        }
        try {
          const stored = await fileChatFile(options, connectionId, file, exec.signal)
          results.push({
            file: stored.file,
            id: stored.id,
            sha256: stored.sha256,
            size_bytes: stored.sizeBytes,
            already_existed: stored.alreadyExisted,
          })
        } catch (error) {
          exec.signal.throwIfAborted()
          results.push({
            file: describeChatFile(file).filename,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return JSON.stringify(results)
    },
  })
}
