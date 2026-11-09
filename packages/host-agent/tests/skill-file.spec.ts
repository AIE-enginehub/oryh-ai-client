import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { skillFileTool } from '../src/skill-file.js'

describe("reading a skill's own files", () => {
  let home: string
  let skills: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'oryh-skill-file-'))
    skills = join(home, 'skills')
    await mkdir(join(skills, 'oryh-my-work', 'references'), { recursive: true })
    await writeFile(join(skills, 'oryh-my-work', 'references', 'api.md'), `# todos\n${'x'.repeat(25_000)}`)
    await writeFile(join(home, 'secret.env'), 'TOKEN=not-for-the-model')
    await symlink(join(home, 'secret.env'), join(skills, 'oryh-my-work', 'references', 'linked.md'))
    await mkdir(join(skills, 'oryh-hidden'), { recursive: true })
    await writeFile(join(skills, 'oryh-hidden', 'notes.md'), 'hidden')
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const tool = () => {
    const definition = (name: string) =>
      name === 'oryh-my-work'
        ? { invocation: { modelInvocable: true }, resourceBase: { kind: 'directory', path: join(skills, name) } }
        : name === 'oryh-hidden'
          ? { invocation: { modelInvocable: false }, resourceBase: { kind: 'directory', path: join(skills, name) } }
          : undefined
    const services: Record<string, unknown> = {
      skills: {
        list: async () => [
          { name: 'oryh-my-work', invocation: { modelInvocable: true } },
          { name: 'oryh-hidden', invocation: { modelInvocable: false } },
        ],
        get: async (name: string) => definition(name),
      },
      workingDirectory: { ensure: async () => home },
    }
    return skillFileTool({ get: (name: string) => services[name] } as never)
  }
  const exec = { agent: { id: 's' }, signal: new AbortController().signal } as never

  it('reads a reference the skill names, a page at a time', async () => {
    const first = JSON.parse(await tool().execute({ skill: 'oryh-my-work', path: 'references/api.md' }, exec))
    expect(first.text.startsWith('# todos')).toBe(true)
    expect(first).toMatchObject({ more: true, next_offset: 20_000 })
    const rest = JSON.parse(
      await tool().execute({ skill: 'oryh-my-work', path: 'references/api.md', offset: first.next_offset }, exec),
    )
    expect(rest.more).toBe(false)
  })

  it('reads nothing outside the skill, nor a skill the session was not offered', async () => {
    const read = (skill: string, path: string) => tool().execute({ skill, path }, exec)
    await expect(read('oryh-my-work', '../../secret.env')).rejects.toThrow('只能读取 skill 自己目录里的文件')
    await expect(read('oryh-my-work', join(home, 'secret.env'))).rejects.toThrow('相对路径')
    await expect(read('oryh-my-work', 'references/linked.md')).rejects.toThrow('只能读取 skill 自己目录里的文件')
    await expect(read('oryh-my-work', 'references/none.md')).rejects.toThrow('没有')
    await expect(read('oryh-hidden', 'notes.md')).rejects.toThrow('没有名为 oryh-hidden')
    await expect(read('oryh-unknown', 'SKILL.md')).rejects.toThrow('没有名为 oryh-unknown')
  })
})
