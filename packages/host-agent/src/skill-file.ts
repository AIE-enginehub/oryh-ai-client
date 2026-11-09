/**
 * Reading the files a skill ships beside its instructions.
 *
 * A skill names its references by relative path — `references/api.md` holds the fields a create takes —
 * and Harness tells the agent the skill's directory. Where the deployment offers no shell, nothing could
 * read them: asked to make a todo, the agent learned the request's fields by sending it, twice, before it
 * had asked the person anything; only ORYH's validation kept those sends from writing. This reads one file
 * of a skill this session was offered, by the skill's name and a path inside its directory, and nothing
 * outside it.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OryhClientError } from '@oryh/ai-client-foundation'
import { textOutput } from '@oryh/dsh-pane'

export const SKILL_FILE_TOOL = 'oryh_skill_file'

export const SKILL_FILE_RULE =
  'skill 里提到的参考文件（如 references/api.md、references/fields.md）用 oryh_skill_file 按 skill 名和相对路径读取；要知道写入接口收哪些字段时先读这些文件，或用 GET 读一条现有记录，不要靠发写入请求来试探。'

/** A reference larger than this is no reference. */
const MAX_BYTES = 1024 * 1024
const PAGE = 20_000

const fail = (text: string) => new OryhClientError(text, 'request-failed')

/** What this tool asks of Harness's skill registry and working directories; both are Harness's own. */
interface SkillLookup {
  list(options: object): Promise<readonly { name: string; invocation?: { modelInvocable?: boolean } }[]>
  get(
    name: string,
    options: object,
  ): Promise<{ invocation?: { modelInvocable?: boolean }; resourceBase?: { kind: string; path?: string } } | undefined>
}
interface WorkingDirectories {
  ensure(agent: unknown, signal: AbortSignal): Promise<string>
}

/**
 * Where a relative path inside a skill's directory leads, refusing anything that leaves it — by `..`, by
 * an absolute path, or through a link.
 * @param base - the skill's directory.
 * @param path - the path the skill names.
 * @returns the file's real path.
 */
export async function insideSkill(base: string, path: string): Promise<string> {
  if (!path || isAbsolute(path)) throw fail('path 用 skill 目录里的相对路径，例如 references/api.md。')
  const root = await realpath(base)
  let file: string
  try {
    file = await realpath(resolve(root, path))
  } catch {
    throw fail(`这个 skill 里没有 ${path}。`)
  }
  const inside = relative(root, file)
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside))
    throw fail('只能读取 skill 自己目录里的文件。')
  return file
}

/**
 * The tool, over Harness's skill registry.
 * @param ctx - the Host context that holds the registry.
 */
export function skillFileTool(ctx: Context) {
  return defineTool({
    name: SKILL_FILE_TOOL,
    description:
      '读取本会话可用的某个 ORYH skill 目录里的文本文件（skill 正文里提到的 references/…、examples/… 等）。' +
      'skill 填 skill 名，path 填 skill 里写的相对路径。文件长时按 offset 分页，返回 more 为 true 时用 next_offset 继续。只读，不读 skill 目录以外的文件，也不写入 ORYH。',
    parameters: {
      skill: { type: 'string', required: true, description: 'skill 名，例如 oryh-my-work。' },
      path: { type: 'string', required: true, description: 'skill 目录里的相对路径，例如 references/api.md。' },
      offset: { type: 'integer', description: '跳过的字符数，默认 0。' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      if (!exec.agent) throw fail('需要会话。')
      const skills = ctx.get('skills' as never) as SkillLookup | undefined
      const directories = ctx.get('workingDirectory' as never) as WorkingDirectories | undefined
      if (!skills) throw fail('本次运行没有装载 skill。')
      const cwd = directories ? await directories.ensure(exec.agent, exec.signal) : undefined
      const lookup = { cwd, signal: exec.signal, scope: exec.agent }
      const offered = (await skills.list(lookup)).find(skill => skill.name === args.skill)
      if (!offered || offered.invocation?.modelInvocable === false)
        throw fail(`本会话没有名为 ${args.skill} 的 skill。`)
      const skill = await skills.get(args.skill, lookup)
      if (!skill || skill.invocation?.modelInvocable === false) throw fail(`本会话没有名为 ${args.skill} 的 skill。`)
      if (skill.resourceBase?.kind !== 'directory' || !skill.resourceBase.path)
        throw fail('这个 skill 不是从本机目录装载的，没有可以读取的文件。')
      const file = await insideSkill(skill.resourceBase.path, args.path)
      const info = await stat(file)
      if (!info.isFile()) throw fail(`${args.path} 不是文件。`)
      if (info.size > MAX_BYTES) throw fail(`${args.path} 超过 1 MB，不是可以读取的参考文件。`)
      const text = new TextDecoder('utf-8').decode(await readFile(file, { signal: exec.signal }))
      if (text.includes('\u0000')) throw fail(`${args.path} 不是文本文件。`)
      const offset = Math.max(0, Math.trunc(args.offset ?? 0))
      const page = text.slice(offset, offset + PAGE)
      const end = offset + page.length
      return JSON.stringify({
        skill: args.skill,
        path: args.path,
        characters: text.length,
        offset,
        text: page,
        ...(end < text.length ? { more: true, next_offset: end } : { more: false }),
      })
    },
  })
}
