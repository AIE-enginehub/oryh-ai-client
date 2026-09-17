import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  type ConnectionId,
  connectionId,
  type OperationResultId,
  operationResultId,
  type SavedOperationId,
  savedOperationId,
} from './brand.js'
import { OryhClientError } from './errors.js'
import type { OperationId } from './operations.js'

/** Browser-safe view of a deterministic operation the user pinned for later refresh. */
export interface SavedOperationView {
  readonly id: SavedOperationId
  readonly connectionId: ConnectionId
  readonly operationId: OperationId
  /** Receipt that established the saved program. It never contains request credentials. */
  readonly sourceResultId: OperationResultId
  readonly label: string
  readonly createdAt: string
}

/** Input needed to pin one result's known operation program. */
export interface SaveOperationInput {
  readonly connectionId: ConnectionId
  readonly operationId: OperationId
  readonly resultId: OperationResultId
  readonly label: string
}

/** Durable storage for browser-safe saved direct-operation records. */
export interface SavedOperationStore {
  /** Return every saved operation record without filtering by active connection. */
  load(): Promise<readonly SavedOperationView[]>
  /** Atomically replace every saved operation record. */
  save(operations: readonly SavedOperationView[]): Promise<void>
}

/** In-memory saved-operation storage for tests and development-only compositions. */
export class MemorySavedOperationStore implements SavedOperationStore {
  #operations: readonly SavedOperationView[]

  constructor(initial: readonly SavedOperationView[] = []) {
    this.#operations = [...initial]
  }

  async load(): Promise<readonly SavedOperationView[]> {
    return [...this.#operations]
  }

  async save(operations: readonly SavedOperationView[]): Promise<void> {
    this.#operations = [...operations]
  }
}

/** Configuration for a non-secret JSON file that stores saved direct operations. */
export interface JsonSavedOperationStoreOptions {
  /** Absolute file path in the local client data directory. */
  readonly path: string
}

const SAVED_OPERATION_STORE_VERSION = 1
const MAX_SAVED_OPERATION_STORE_BYTES = 1024 * 1024

/**
 * Atomic JSON store for saved operation identities and labels. It never stores
 * operation payloads, device codes, access keys, or refresh tokens.
 */
export class JsonSavedOperationStore implements SavedOperationStore {
  readonly #path: string

  constructor(options: JsonSavedOperationStoreOptions) {
    if (options.path.length === 0) {
      throw new OryhClientError('ORYH saved-operation metadata path must not be empty.', 'connection-store-failed')
    }
    this.#path = options.path
  }

  async load(): Promise<readonly SavedOperationView[]> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error: unknown) {
      if (isMissingFile(error)) return []
      throw storeError('read')
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_SAVED_OPERATION_STORE_BYTES) {
      throw new OryhClientError('ORYH saved-operation metadata is too large.', 'connection-store-failed')
    }
    try {
      return decodeStore(JSON.parse(raw))
    } catch (error: unknown) {
      if (error instanceof OryhClientError) throw error
      throw new OryhClientError('ORYH saved-operation metadata is invalid.', 'connection-store-failed')
    }
  }

  async save(operations: readonly SavedOperationView[]): Promise<void> {
    const content = JSON.stringify({ version: SAVED_OPERATION_STORE_VERSION, operations }, undefined, 2)
    const directory = dirname(this.#path)
    const temporaryPath = join(directory, `.${basename(this.#path)}.${randomUUID()}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.#path)
    } catch {
      throw storeError('write')
    }
  }
}

/** In-memory saved-operation registry; a desktop persistence provider will implement the same semantics. */
export class SavedOperationRegistry {
  readonly #saved = new Map<SavedOperationId, SavedOperationView>()
  #nextId = 1

  /** Persist an allowlisted operation identity, never its credential or arbitrary request code. */
  save(input: SaveOperationInput, createdAt: string): SavedOperationView {
    const label = normalizeLabel(input.label)
    const view: SavedOperationView = {
      id: savedOperationId(`saved-operation-${this.#nextId}`),
      connectionId: input.connectionId,
      operationId: input.operationId,
      sourceResultId: input.resultId,
      label,
      createdAt,
    }
    this.#nextId += 1
    this.#saved.set(view.id, view)
    return view
  }

  /** List views belonging only to one selected ORYH connection. */
  list(connectionId: ConnectionId): readonly SavedOperationView[] {
    return [...this.#saved.values()].filter(view => view.connectionId === connectionId)
  }

  /** Return every record so the owning persistent store can replace its complete snapshot. */
  listAll(): readonly SavedOperationView[] {
    return [...this.#saved.values()]
  }

  /** Restore validated records from an owning persistent store before exposing the registry. */
  restore(operations: readonly SavedOperationView[]): void {
    const restored = new Map<SavedOperationId, SavedOperationView>()
    for (const operation of operations) {
      validateView(operation)
      if (restored.has(operation.id)) {
        throw new OryhClientError(
          'ORYH saved-operation metadata contains duplicate operation IDs.',
          'connection-store-failed',
        )
      }
      restored.set(operation.id, operation)
    }
    this.#saved.clear()
    for (const [id, operation] of restored) this.#saved.set(id, operation)
    this.#nextId = 1
    while (this.#saved.has(savedOperationId(`saved-operation-${this.#nextId}`))) this.#nextId += 1
  }

  /** Remove every saved action scoped to a disconnected local enterprise. */
  removeConnection(connectionId: ConnectionId): void {
    for (const [id, operation] of this.#saved) {
      if (operation.connectionId === connectionId) this.#saved.delete(id)
    }
  }

  /** Resolve a view and refuse an attempt to invoke it under another connection. */
  require(connectionId: ConnectionId, savedOperationId: SavedOperationId): SavedOperationView {
    const saved = this.#saved.get(savedOperationId)
    if (saved === undefined) {
      throw new OryhClientError('The saved ORYH operation no longer exists.', 'operation-not-found')
    }
    if (saved.connectionId !== connectionId) {
      throw new OryhClientError('A saved ORYH operation cannot be used across connections.', 'cross-connection-result')
    }
    return saved
  }
}

function normalizeLabel(value: string): string {
  const label = value.trim()
  if (label.length === 0 || label.length > 120) {
    throw new OryhClientError('Saved ORYH operation labels must contain 1 to 120 characters.', 'request-failed')
  }
  return label
}

function decodeStore(value: unknown): readonly SavedOperationView[] {
  const record = asRecord(value)
  if (record.version !== SAVED_OPERATION_STORE_VERSION || !Array.isArray(record.operations)) {
    throw new OryhClientError('ORYH saved-operation metadata is invalid.', 'connection-store-failed')
  }
  const seen = new Set<string>()
  return record.operations.map(item => {
    const operation = decodeView(item)
    if (seen.has(operation.id)) {
      throw new OryhClientError(
        'ORYH saved-operation metadata contains duplicate operation IDs.',
        'connection-store-failed',
      )
    }
    seen.add(operation.id)
    return operation
  })
}

function decodeView(value: unknown): SavedOperationView {
  const record = asRecord(value)
  const id = string(record.id)
  const rawConnectionId = string(record.connectionId)
  const rawSourceResultId = string(record.sourceResultId)
  const rawOperationId = string(record.operationId)
  if (
    !/^saved-operation-[1-9][0-9]*$/u.test(id) ||
    !/^oryh-[1-9][0-9]*$/u.test(rawConnectionId) ||
    !/^result-[1-9][0-9]*$/u.test(rawSourceResultId) ||
    (rawOperationId !== 'my-open-todos' && rawOperationId !== 'my-expense-claims' && rawOperationId !== 'list-projects')
  ) {
    throw new OryhClientError('ORYH saved-operation metadata is invalid.', 'connection-store-failed')
  }
  const createdAt = string(record.createdAt)
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new OryhClientError('ORYH saved-operation metadata is invalid.', 'connection-store-failed')
  }
  return {
    id: savedOperationId(id),
    connectionId: connectionId(rawConnectionId),
    operationId: rawOperationId,
    sourceResultId: operationResultId(rawSourceResultId),
    label: normalizeLabel(string(record.label)),
    createdAt,
  }
}

function validateView(value: SavedOperationView): void {
  decodeView(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OryhClientError('ORYH saved-operation metadata is invalid.', 'connection-store-failed')
  }
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OryhClientError('ORYH saved-operation metadata is invalid.', 'connection-store-failed')
  }
  return value
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function storeError(operation: 'read' | 'write'): OryhClientError {
  return new OryhClientError(`ORYH saved-operation metadata ${operation} failed.`, 'connection-store-failed')
}
