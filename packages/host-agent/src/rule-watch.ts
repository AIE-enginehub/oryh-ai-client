/**
 * Whether the rules an agent read earlier in a conversation are still the tenant's rules.
 *
 * ORYH keeps a tenant's rules — who approves, what a document must carry, what follows — as text an
 * agent reads when it decides (`/business-rules`), and its skills say to read them then and never to go
 * by memory. In a long conversation the agent went by what it had read: the rule text was in the
 * conversation, so it did not ask again, and a rule an admin had changed since stayed the old rule for as
 * long as that conversation lasted. A new conversation read afresh, which is how it was noticed.
 *
 * Being told to read every time is a rule the agent already had. What it lacked was any way to know that
 * something it could see in front of it was no longer true. So the Host asks for it: each read of the
 * rules a session makes is remembered, asked of ORYH again when a later turn starts, and when the answer
 * has changed the agent is told which rules, in its context, until it has read them again. The Host
 * reads no rule's meaning and enforces none — it says only that what was read has been replaced.
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from '@oryh/ai-client-foundation'
import { conditionsOf } from './follow.js'

/** The query parameters that say which rules a read was for; the rest say how much to read, or as of when. */
const SCOPE_KEYS = ['kind', 'entity_kind', 'object_type', 'category', 'code', 'name'] as const
const RULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** How many reads of rules one session is followed for; the oldest goes first. */
const WATCHED_LIMIT = 12

interface Watched {
  tool: string
  args: unknown
  /** What the read was for, as the agent is told it. */
  label: string
  digest: string
  checkedAt: number
  changed: boolean
}

/** Every string in a call's arguments, to the depth a tool's parameters go. */
function strings(args: unknown, depth = 0): string[] {
  if (typeof args === 'string') return [args]
  if (depth > 2 || !args || typeof args !== 'object') return []
  return Object.values(args as Record<string, unknown>).flatMap(value => strings(value, depth + 1))
}

/**
 * Which rules a call read, if it read rules: their scope as a key, and as words for the agent.
 *
 * A call names the collection in a path (`/business-rules?…`, `/business-rules/<id>`) or as a parameter
 * of its own (`oryh_list`), so every string in the arguments is looked at, as the pane does to follow a read.
 * @param args - the call's arguments.
 */
export function ruleScope(args: unknown): { key: string; label: string } | undefined {
  let id: string | undefined
  let rules = false
  for (const value of strings(args)) {
    const [collection, second] = value
      .split('?')[0]!
      .replace(/^\/api\/v1(?=\/|$)/, '')
      .replace(/^\//, '')
      .split('/')
    if (collection !== 'business-rules') continue
    rules = true
    if (second !== undefined && RULE_ID.test(second)) id = second
  }
  if (!rules) return undefined
  if (id) return { key: `id=${id}`, label: `编号为 ${id} 的那一条` }
  const conditions = conditionsOf(args)
  const scope = SCOPE_KEYS.flatMap(key => (conditions[key] ? [`${key}=${conditions[key]}`] : []))
  return scope.length ? { key: scope.join('&'), label: scope.join('，') } : { key: '*', label: '全部规则' }
}

/**
 * What a read of the rules answered, reduced to what makes a rule the rule it is: which rows, in which
 * version, saying what. An answer's request id or timing is not a change of rule.
 * @param text - the tool's answer.
 */
export function ruleDigest(text: string): string {
  let rows: unknown = text
  try {
    const data = (JSON.parse(text) as { data?: unknown })?.data
    const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : undefined
    if (list)
      rows = list
        .map(row => {
          const rule = (row ?? {}) as Record<string, unknown>
          return [rule.id, rule.version, rule.status, rule.body, rule.effective_from, rule.effective_to]
        })
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  } catch {
    /* not JSON: the text itself is what was read */
  }
  return createHash('sha256').update(canonicalJson(rows)).digest('hex')
}

export class RuleWatch {
  readonly #sessions = new Map<string, Map<string, Watched>>()

  /**
   * @param replay - make the same read again for a session and return its answer; it throws when it cannot.
   * @param gapMs - how soon the same read may be asked again; a turn starts more often than rules change.
   */
  constructor(
    private readonly replay: (sessionId: string, tool: string, args: unknown, signal: AbortSignal) => Promise<string>,
    private readonly gapMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The agent read ORYH. Remembered when what it read was the tenant's rules: that read is now what the
   * session knows of them, and whatever was said to have changed in that scope has been read again.
   * @param tool - the tool the agent called, to ask the same way again.
   */
  read(sessionId: string, tool: string, args: unknown, text: string): void {
    const scope = ruleScope(args)
    if (!scope) return
    let watched = this.#sessions.get(sessionId)
    if (!watched) this.#sessions.set(sessionId, (watched = new Map()))
    // Read again, it goes to the back: the limit drops what the conversation has gone longest without.
    watched.delete(scope.key)
    watched.set(scope.key, {
      tool,
      args: structuredClone(args),
      label: scope.label,
      digest: ruleDigest(text),
      checkedAt: this.now(),
      changed: false,
    })
    while (watched.size > WATCHED_LIMIT) watched.delete(watched.keys().next().value!)
  }

  /**
   * Ask ORYH again for what this session read, and mark what answers differently. Called as a turn
   * starts. A read that cannot be made again says nothing either way: the next turn asks once more.
   */
  async check(sessionId: string, signal = AbortSignal.timeout(3000)): Promise<void> {
    const watched = this.#sessions.get(sessionId)
    if (!watched) return
    await Promise.all(
      [...watched.entries()].map(async ([key, entry]) => {
        if (entry.changed || this.now() - entry.checkedAt < this.gapMs) return
        const previousCheck = entry.checkedAt
        entry.checkedAt = this.now()
        let digest: string
        let off = () => {}
        try {
          signal.throwIfAborted()
          const aborted = new Promise<never>((_resolve, reject) => {
            const cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            off = () => signal.removeEventListener('abort', cancel)
          })
          digest = ruleDigest(await Promise.race([this.replay(sessionId, entry.tool, entry.args, signal), aborted]))
        } catch {
          if (watched.get(key) === entry) entry.checkedAt = previousCheck
          return
        } finally {
          off()
        }
        // The agent may have read this scope again while ORYH was being asked: that read is the newer one.
        if (watched.get(key) === entry && digest !== entry.digest) entry.changed = true
      }),
    )
  }

  /**
   * What the agent is told while rules it read have changed and it has not read them again; empty when
   * there is nothing to tell.
   */
  notice(sessionId: string): string {
    const changed = [...(this.#sessions.get(sessionId)?.values() ?? [])].filter(entry => entry.changed)
    if (!changed.length) return ''
    return `企业的业务规则在本会话期间有变化：${changed.map(entry => `「${entry.label}」`).join('、')}。对话里早些时候读到的这些规则已经作废，不要再依据它们填写、核对或提交；先按 skill 重新读取现行规则，再继续，并告诉用户规则有更新。重新读过之后这条提示会消失。`
  }

  /** A session has ended: nothing of it is asked again. */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }
}
