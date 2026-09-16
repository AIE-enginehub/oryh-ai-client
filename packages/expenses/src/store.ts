import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, open, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Entry } from '@napi-rs/keyring'
import { expenseError, type ExpenseDraft } from './contracts.js'

export interface ExpenseRecord extends ExpenseDraft {
  archived?: boolean
  scope: string
  serverDigest?: string | undefined
}
/** Compare-and-append store; each immutable revision permits at most one writer. */
export interface ExpenseStore {
  list(): Promise<ExpenseRecord[]>
  append(record: ExpenseRecord, previousRevision: number): Promise<void>
}
export class MemoryExpenseStore implements ExpenseStore {
  private readonly records = new Map<string, ExpenseRecord>()
  async list(): Promise<ExpenseRecord[]> { return structuredClone([...this.records.values()]) }
  async append(record: ExpenseRecord, previousRevision: number): Promise<void> {
    if ((this.records.get(record.id)?.revision ?? 0) !== previousRevision) throw expenseError('草稿已改变，请刷新后重试。')
    this.records.set(record.id, structuredClone(record))
  }
}

/**
 * AES-GCM snapshots, with a separate OS-keychain key for this data directory.
 *
 * This duplicates @oryh/ai-client-store's EncryptedRevisionStore almost exactly, differing
 * only in the keychain service name and the wording and code of its errors. It could become
 * a subclass, but that would change observable error text, so the duplication is moved
 * verbatim here and recorded as a separate consolidation.
 */
export class EncryptedExpenseStore implements ExpenseStore {
  private readonly directory: string
  constructor(directory: string, private readonly keyProvider?: () => Promise<Buffer>) { this.directory = resolve(directory) }

  private async key(create: boolean): Promise<Buffer> {
    if (this.keyProvider !== undefined) return this.keyProvider()
    const account = createHash('sha256').update(this.directory).digest('hex')
    const entry = new Entry('ORYH AI Client Expense Encryption', account)
    const existing = entry.getPassword()
    if (existing !== null) {
      const key = Buffer.from(existing, 'base64')
      if (key.length !== 32) throw expenseError('费用草稿加密密钥无效。')
      return key
    }
    if (!create) throw expenseError('费用草稿的加密密钥不可用，不能读取或覆盖记录。')
    const lockPath = join(this.directory, '.key-initialization')
    const lock = await open(lockPath, 'wx', 0o600)
    try {
      const current = entry.getPassword()
      if (current !== null) return Buffer.from(current, 'base64')
      const key = randomBytes(32)
      entry.setPassword(key.toString('base64'))
      return key
    } finally { await lock.close(); await unlink(lockPath) }
  }

  async list(): Promise<ExpenseRecord[]> {
    let names: string[]
    try { names = await readdir(this.directory) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const latest = new Map<string, { revision: number; name: string }>()
    for (const name of names) {
      const match = /^([a-f0-9-]{36})\.(\d+)\.enc$/u.exec(name)
      if (match === null) continue
      const id = match[1]!
      const revision = Number(match[2])
      if (revision > (latest.get(id)?.revision ?? 0)) latest.set(id, { revision, name })
    }
    if (latest.size === 0) return []
    const key = await this.key(false)
    return Promise.all([...latest].map(async ([id, { revision, name }]) => {
      try {
        const raw = await readFile(join(this.directory, name))
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
        decipher.setAAD(Buffer.from(`${id}:${revision}`))
        decipher.setAuthTag(raw.subarray(12, 28))
        const record = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as ExpenseRecord
        if (record.id !== id || record.revision !== revision) throw new Error('Revision mismatch')
        return record
      } catch { throw expenseError('费用执行记录不完整或无法解密。为避免重复写入，已停止操作。') }
    }))
  }

  async append(record: ExpenseRecord, previousRevision: number): Promise<void> {
    if (!/^[a-f0-9-]{36}$/u.test(record.id) || record.revision !== previousRevision + 1) throw expenseError('费用记录版本无效。')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const current = (await this.list()).find(item => item.id === record.id)
    if ((current?.revision ?? 0) !== previousRevision) throw expenseError('草稿已改变，请刷新后重试。')
    const key = await this.key(current === undefined)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(`${record.id}:${record.revision}`))
    const content = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()])
    let file
    try { file = await open(join(this.directory, `${record.id}.${record.revision}.enc`), 'wx', 0o600) }
    catch { throw expenseError('另一请求已修改草稿，请刷新。') }
    try { await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), content])); await file.sync() }
    finally { await file.close() }
    // Make the revision's directory entry durable before permitting any remote write.
    const directory = await open(this.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
