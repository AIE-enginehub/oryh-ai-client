/** Encrypted compare-and-append revision storage, shared by ORYH domain packages. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Entry } from '@napi-rs/keyring'
import { OryhClientError } from '@oryh/ai-client-foundation'

/**
 * Failure raised by the revision store.
 *
 * The `timesheet-conflict` code is preserved verbatim from where this class used to live,
 * so extracting it changed no behaviour. It is wrong for the other domains that use this
 * store — project storage failures report a timesheet conflict today — and correcting it
 * is a deliberate, separate change rather than something smuggled into a file move.
 * @param message - user-facing explanation.
 * @returns the error to throw.
 */
function storeError(message: string): OryhClientError {
  return new OryhClientError(message, 'timesheet-conflict')
}

/** AES-GCM snapshots, with a separate OS-keychain key for this data directory. */
export class EncryptedRevisionStore<T extends { id: string; revision: number }> {
  private readonly directory: string
  /**
   * @param directory - data directory holding one file per revision.
   * @param keyProvider - supplies the key directly; tests use it to avoid the OS keychain.
   * @param keyService - OS-keychain service name. The default is the account existing
   * records were written under, so changing it would orphan every stored revision.
   */
  constructor(
    directory: string,
    private readonly keyProvider?: () => Promise<Buffer>,
    private readonly keyService = 'ORYH AI Client Timesheet Encryption',
  ) {
    this.directory = resolve(directory)
  }

  private async key(create: boolean): Promise<Buffer> {
    if (this.keyProvider !== undefined) return this.keyProvider()
    const account = createHash('sha256').update(this.directory).digest('hex')
    const entry = new Entry(this.keyService, account)
    const existing = entry.getPassword()
    if (existing !== null) {
      const key = Buffer.from(existing, 'base64')
      if (key.length !== 32) throw storeError('执行记录加密密钥无效。')
      return key
    }
    if (!create) throw storeError('执行记录的加密密钥不可用，不能读取或覆盖记录。')
    const lockPath = join(this.directory, '.key-initialization')
    const lock = await open(lockPath, 'wx', 0o600)
    try {
      const current = entry.getPassword()
      if (current !== null) return Buffer.from(current, 'base64')
      const key = randomBytes(32)
      entry.setPassword(key.toString('base64'))
      return key
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
  }

  async list(): Promise<T[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
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
    return Promise.all(
      [...latest].map(async ([id, { revision, name }]) => {
        try {
          const raw = await readFile(join(this.directory, name))
          const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
          decipher.setAAD(Buffer.from(`${id}:${revision}`))
          decipher.setAuthTag(raw.subarray(12, 28))
          const record = JSON.parse(
            Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'),
          ) as T
          if (record.id !== id || record.revision !== revision) throw new Error('Revision mismatch')
          return record
        } catch {
          throw storeError('执行记录不完整或无法解密。为避免重复写入，已停止操作。')
        }
      }),
    )
  }

  async append(record: T, previousRevision: number): Promise<void> {
    if (!/^[a-f0-9-]{36}$/u.test(record.id) || record.revision !== previousRevision + 1)
      throw storeError('执行记录版本无效。')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const current = (await this.list()).find(item => item.id === record.id)
    if ((current?.revision ?? 0) !== previousRevision) throw storeError('记录已改变，请刷新后重试。')
    const key = await this.key(current === undefined)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(`${record.id}:${record.revision}`))
    const content = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()])
    let file
    try {
      file = await open(join(this.directory, `${record.id}.${record.revision}.enc`), 'wx', 0o600)
    } catch {
      throw storeError('另一请求已修改记录，请刷新。')
    }
    try {
      await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), content]))
      await file.sync()
    } finally {
      await file.close()
    }
    // Make the revision's directory entry durable before permitting any remote write.
    const directory = await open(this.directory, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}
