import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { ConnectionId } from './brand.js'
import type { OryhHttpClient } from './http.js'
import { OryhMcpClient } from './mcp.js'

/**
 * ORYH skills, installed from ORYH's MCP endpoint.
 *
 * The capability an ORYH agent has is not compiled in: a tenant admin redefines business logic and
 * everyone's skills change. So this client installs the skills a person is entitled to, into the
 * root the agent runtime scans, and re-syncs when the server says they differ. Nothing here decides
 * what a skill may do — the API's own `require_permission` is the gate, and the server only serves
 * skills the holder's role already covers.
 *
 * The skills come over MCP, not as the downloadable bundle (ADR-0012). The bundle renders the
 * person's API key into SKILL.md, and loading a skill hands its body to the model, so the key went
 * out with the request and into the Session. Over MCP the same skills are rendered for that
 * delivery: no key, no scripts, and every API call is a tool the Host runs with the connection's own
 * credential. Each prompt is a skill's SKILL.md; each resource is one of its reference files.
 *
 * See `docs/23-oryh-skills.md`.
 */

/** One skill as the server currently entitles it: what a local manifest is compared against. */
export interface SkillManifestEntry {
  readonly name: string
  readonly version?: string
  readonly hash?: string
}

/**
 * Whose skills are on disk.
 *
 * ORYH renders the holder's employee id and name into a skill's text, so a skill speaks for that
 * person. The skills root is one directory, so this is what lets the client notice that it no longer
 * belongs to the enterprise identity in use.
 */
export interface SkillPrincipal {
  readonly origin: string
  readonly tenantId: string
  readonly userId: string
  readonly employeeId: string | null
  /** For people to read; never compared. */
  readonly tenantName: string
  /** For people to read; never compared. */
  readonly email: string
}

/**
 * Whether two principals are the same person in the same enterprise.
 * @param a - one principal, possibly unknown.
 * @param b - the other, possibly unknown.
 * @returns true only when both are known and name the same deployment, tenant, user and employee.
 */
export function samePrincipal(a: SkillPrincipal | undefined, b: SkillPrincipal | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.origin === b.origin &&
    a.tenantId === b.tenantId &&
    a.userId === b.userId &&
    a.employeeId === b.employeeId
  )
}

/** Result of a sync attempt, shaped for a status line rather than a log. */
export interface SkillSyncResult {
  readonly installed: boolean
  readonly root: string
  readonly skills: readonly string[]
  readonly message: string
  /** Whose skills are installed after this sync, when the service can tell. */
  readonly principal?: SkillPrincipal
}

/**
 * How skills reached the disk. Only `mcp` counts as current: anything else was a bundle, whose files
 * carry the key, and has to be replaced even when the manifest has not changed.
 */
type Delivery = 'mcp'

interface InstallRecord {
  delivery?: Delivery
  manifest?: readonly SkillManifestEntry[]
  installed?: readonly string[]
  principal?: SkillPrincipal
}

/** Paths a skill is allowed to create, so a server-supplied name cannot write outside the skills root. */
const SAFE_ENTRY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** Where ORYH's MCP resources name their skill and file: `oryh://skills/<skill>/<path>`. */
const SKILL_RESOURCE = /^oryh:\/\/skills\/([^/]+)\/(.+)$/

/**
 * Reject anything that would escape the install root.
 *
 * Skill names and file paths are server-supplied data being written to disk, so they get checked
 * rather than trusted: no absolute paths, no `..`, no backslashes, and the resolved path must still
 * sit under the root. This is cheap and the failure mode it prevents is not.
 * @param root - absolute directory skills may be written into.
 * @param entry - path relative to the root, as the server named it.
 * @returns the absolute destination path.
 */
export function resolveEntry(root: string, entry: string): string {
  if (!SAFE_ENTRY.test(entry) || entry.split('/').includes('..')) {
    throw new OryhClientError(`Refused a skill entry with an unsafe name: ${entry}`, 'invalid-response')
  }
  const destination = resolve(root, entry)
  if (destination !== root && !destination.startsWith(root + sep)) {
    throw new OryhClientError(`Refused a skill entry outside the skills directory: ${entry}`, 'invalid-response')
  }
  return destination
}

/**
 * Whether this client refuses to install a skill.
 *
 * ORYH has a `*-skill-sync` skill so a generic agent can install and refresh its own skills. Here the
 * client is the installer, so that skill would be a second one. ORYH already leaves it out over MCP;
 * this keeps it out should a deployment still serve it. `oryh_skill_sync` is the door instead.
 * @param skill - the skill's name.
 * @returns whether the skill is withheld from this install.
 */
export function withheld(skill: string): boolean {
  return skill.endsWith('-skill-sync')
}

export class SkillBundleService {
  /** Whose skills the last install recorded: undefined until read, null when none is recorded. */
  #installed: SkillPrincipal | null | undefined
  readonly #mcp: OryhMcpClient

  /**
   * @param http - authenticated ORYH transport; the credential never leaves it.
   * @param root - absolute skills directory, scanned by the agent runtime.
   * @param principalOf - the verified identity behind a connection; without it no holder is recorded.
   */
  constructor(
    private readonly http: OryhHttpClient,
    private readonly root: string,
    private readonly principalOf?: (connectionId: ConnectionId) => Promise<SkillPrincipal>,
  ) {
    this.#mcp = new OryhMcpClient(http)
  }

  /**
   * Whose skills are installed, as last recorded, without waiting.
   *
   * Callers that must answer synchronously — the agent's context — get `undefined` once, while the
   * record is read in the background, rather than a guess.
   * @returns the holder, `null` when no holder is recorded, or `undefined` while unknown.
   */
  installedPrincipal(): SkillPrincipal | null | undefined {
    if (this.#installed === undefined)
      void this.record().then(record => {
        if (this.#installed === undefined) this.#installed = record.principal ?? null
      })
    return this.#installed
  }

  /** What the server says this principal is entitled to right now. */
  async manifest(connectionId: ConnectionId): Promise<readonly SkillManifestEntry[]> {
    const body = await this.http.request(connectionId, { path: '/my/skills/manifest' })
    const data = (body as { data?: unknown })?.data
    if (!Array.isArray(data)) return []
    return data.flatMap(row => {
      if (row === null || typeof row !== 'object') return []
      const entry = row as Record<string, unknown>
      return typeof entry.name === 'string'
        ? [
            {
              name: entry.name,
              ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
              ...(typeof entry.hash === 'string' ? { hash: entry.hash } : {}),
            },
          ]
        : []
    })
  }

  /** What the last install recorded: how it was delivered, for whom, and the directories it wrote. */
  private async record(): Promise<InstallRecord> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.root, '.oryh-manifest.json'), 'utf8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as InstallRecord) : {}
    } catch {
      return {}
    }
  }

  /** Directories the previous install owns, so a skill the server withdraws does not linger. */
  private async owned(): Promise<readonly string[]> {
    const installed = (await this.record()).installed
    return Array.isArray(installed) ? installed.filter(name => typeof name === 'string') : []
  }

  /**
   * Install the skills this principal is entitled to when they differ from what is on disk.
   *
   * The server's manifest says whether anything changed — skills gained or lost through a role
   * change included, so a shrinking set syncs too. So does the holder: two people in one tenant can
   * hold identical manifests, and each person's skills speak for that person. And so does delivery:
   * skills installed from a bundle carry the key in their files and are replaced even when nothing
   * else changed.
   * @param connectionId - verified connection whose principal the skills belong to.
   * @param force - install even when nothing differs, for an explicit user-driven refresh.
   * @returns whether anything was written, and the skills now present.
   */
  async sync(connectionId: ConnectionId, force = false): Promise<SkillSyncResult> {
    const [wanted, principal] = await Promise.all([this.manifest(connectionId), this.principalOf?.(connectionId)])
    const record = await this.record()
    const same =
      record.delivery === 'mcp' &&
      record.manifest !== undefined &&
      JSON.stringify(record.manifest) === JSON.stringify(wanted) &&
      (principal === undefined || samePrincipal(record.principal, principal))
    if (same && !force) {
      this.#installed = record.principal ?? null
      return {
        installed: false,
        root: this.root,
        skills: wanted.map(s => s.name),
        message: '技能已是最新。',
        ...(record.principal ? { principal: record.principal } : {}),
      }
    }

    // Read everything before writing anything: a partially applied install is worse than a refused
    // one, because the agent would then hold a mix of two versions.
    const prompts = (await this.#mcp.prompts(connectionId)).filter(prompt => !withheld(prompt.name))
    if (prompts.length === 0) throw new OryhClientError('ORYH 没有通过 MCP 提供任何技能。', 'invalid-response')
    for (const prompt of prompts) {
      if (prompt.name.includes('/'))
        throw new OryhClientError(`Refused a skill entry with an unsafe name: ${prompt.name}`, 'invalid-response')
      resolveEntry(this.root, prompt.name)
    }
    const names = new Set(prompts.map(prompt => prompt.name))
    const bodies = await this.#mcp.promptTexts(connectionId, [...names])
    const planned: [target: string, text: string][] = []
    for (const name of names) {
      const body = bodies.get(name)
      if (body === undefined) throw new OryhClientError(`ORYH 没有返回技能 ${name} 的内容。`, 'invalid-response')
      planned.push([`${name}/SKILL.md`, body])
    }
    const files = (await this.#mcp.resources(connectionId)).flatMap(uri => {
      const match = SKILL_RESOURCE.exec(uri)
      return match !== null && names.has(match[1]!) && match[2] !== 'SKILL.md'
        ? [[uri, `${match[1]}/${match[2]}`] as const]
        : []
    })
    const texts = await this.#mcp.resourceTexts(
      connectionId,
      files.map(([uri]) => uri),
    )
    for (const [uri, target] of files) {
      const text = texts.get(uri)
      if (text !== undefined) planned.push([target, text])
    }
    for (const [target] of planned) resolveEntry(this.root, target)

    // Replace each skill directory wholesale rather than merging, so a file the server stopped
    // serving — or a bundle's key-bearing script — actually disappears. Only directories this client
    // owns are touched: the root is shared with whatever else the user has installed for other agents.
    const owned = [...names]
    for (const previous of await this.owned()) {
      if (!names.has(previous)) await rm(join(this.root, previous), { recursive: true, force: true })
    }
    for (const directory of owned) await rm(join(this.root, directory), { recursive: true, force: true })
    for (const [target, text] of planned) {
      const destination = resolveEntry(this.root, target)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, text)
    }
    await mkdir(this.root, { recursive: true })
    const written: InstallRecord = {
      delivery: 'mcp',
      manifest: wanted,
      installed: owned,
      ...(principal ? { principal } : {}),
    }
    await writeFile(join(this.root, '.oryh-manifest.json'), JSON.stringify(written, null, 2))
    this.#installed = principal ?? null
    return {
      installed: true,
      root: this.root,
      skills: owned,
      message: `已从 ORYH MCP 安装 ${owned.length} 个技能。`,
      ...(principal ? { principal } : {}),
    }
  }
}
