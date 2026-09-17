import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionId } from '../src/brand.js'
import { resolveEntry, SkillBundleService } from '../src/skill-bundle.js'

const connectionId = 'c' as ConnectionId
const manifest = [{ name: 'oryh-timesheet-submit', version: '3', hash: 'h3' }]
type Skills = Record<string, Record<string, string>>

/**
 * A stand-in for ORYH: the manifest over REST, the skills over MCP — prompts for SKILL.md, resources
 * for reference files. The service must never touch a credential itself; the transport carries it.
 */
function oryh(skills: Skills, entries: unknown[] = manifest) {
  const calls: string[] = []
  const answer = (message: { id: number; method: string; params?: { name?: string; uri?: string } }) => {
    calls.push(message.method)
    const result = (() => {
      switch (message.method) {
        case 'prompts/list':
          return { prompts: Object.keys(skills).map(name => ({ name, description: name })) }
        case 'prompts/get':
          return {
            messages: [{ role: 'user', content: { type: 'text', text: skills[message.params!.name!]!['SKILL.md'] } }],
          }
        case 'resources/list':
          return {
            resources: Object.entries(skills).flatMap(([name, files]) =>
              Object.keys(files)
                .filter(path => path !== 'SKILL.md')
                .map(path => ({ uri: `oryh://skills/${name}/${path}` })),
            ),
          }
        case 'resources/read': {
          const [, name, path] = /^oryh:\/\/skills\/([^/]+)\/(.+)$/.exec(message.params!.uri!)!
          return { contents: [{ uri: message.params!.uri, text: skills[name!]![path!] }] }
        }
        default:
          throw new Error(`unexpected ${message.method}`)
      }
    })()
    return { jsonrpc: '2.0', id: message.id, result }
  }
  return {
    calls,
    client: {
      request: async (_id: ConnectionId, r: { path: string; root?: boolean; body?: unknown }) => {
        if (r.path === '/my/skills/manifest') {
          calls.push('manifest')
          return { data: entries }
        }
        expect(r).toMatchObject({ path: '/mcp', root: true })
        return Array.isArray(r.body) ? r.body.map(answer) : answer(r.body as never)
      },
    } as never,
  }
}

describe('ORYH skills over MCP', () => {
  it('installs every skill from MCP and skips the fetch when nothing changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    const server = oryh({
      'oryh-timesheet-submit': {
        'SKILL.md': '---\nname: oryh-timesheet-submit\n---\nEvery call is one `oryh_request` tool call.',
        'references/api.md': 'the API',
      },
    })
    const service = new SkillBundleService(server.client, root)

    const first = await service.sync(connectionId)
    expect(first.installed).toBe(true)
    expect(await readFile(join(root, 'oryh-timesheet-submit/SKILL.md'), 'utf8')).toContain('oryh_request')
    expect(await readFile(join(root, 'oryh-timesheet-submit/references/api.md'), 'utf8')).toBe('the API')
    expect(JSON.parse(await readFile(join(root, '.oryh-manifest.json'), 'utf8')).delivery).toBe('mcp')

    // The manifest is what says whether anything changed: an unchanged entitlement fetches nothing.
    const before = server.calls.filter(call => call === 'prompts/get').length
    expect((await service.sync(connectionId)).installed).toBe(false)
    expect(server.calls.filter(call => call === 'prompts/get')).toHaveLength(before)
    // An explicit refresh still fetches everything again.
    expect((await service.sync(connectionId, true)).installed).toBe(true)
  })

  it('replaces skills a bundle installed, even under an unchanged manifest, because their files carry the key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    await mkdir(join(root, 'example-acme-timesheet-submit/scripts'), { recursive: true })
    await writeFile(join(root, 'example-acme-timesheet-submit/SKILL.md'), 'api_key: "the person\'s key"')
    await writeFile(
      join(root, 'example-acme-timesheet-submit/scripts/oryh_request.py'),
      'DEFAULT_API_KEY = "the person\'s key"',
    )
    await writeFile(
      join(root, '.oryh-manifest.json'),
      JSON.stringify({ manifest, installed: ['example-acme-timesheet-submit'] }),
    )
    const service = new SkillBundleService(oryh({ 'oryh-timesheet-submit': { 'SKILL.md': 'over MCP' } }).client, root)

    expect((await service.sync(connectionId)).installed).toBe(true)
    await expect(readFile(join(root, 'example-acme-timesheet-submit/SKILL.md'), 'utf8')).rejects.toThrow()
    await expect(
      readFile(join(root, 'example-acme-timesheet-submit/scripts/oryh_request.py'), 'utf8'),
    ).rejects.toThrow()
    expect(await readFile(join(root, 'oryh-timesheet-submit/SKILL.md'), 'utf8')).toBe('over MCP')
  })

  it('replaces a skill directory wholesale, and removes a skill the server stopped serving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    await new SkillBundleService(
      oryh({ 'oryh-timesheet-submit': { 'SKILL.md': 'hours' }, 'oryh-approve': { 'SKILL.md': 'approve' } }).client,
      root,
    ).sync(connectionId)
    await writeFile(join(root, 'oryh-timesheet-submit/stale.md'), 'left behind')

    // A role change withdraws a skill: the next install must not keep it.
    await new SkillBundleService(
      oryh({ 'oryh-timesheet-submit': { 'SKILL.md': 'fresh' } }, [{ name: 'changed' }]).client,
      root,
    ).sync(connectionId)
    await expect(readFile(join(root, 'oryh-timesheet-submit/stale.md'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'oryh-approve/SKILL.md'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, 'oryh-timesheet-submit/SKILL.md'), 'utf8')).toBe('fresh')
  })

  it("withholds ORYH's own installer skill, because this client is the installer", async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    const result = await new SkillBundleService(
      oryh({
        'oryh-skill-sync': { 'SKILL.md': 'a second installer' },
        'oryh-timesheet-submit': { 'SKILL.md': 'hours' },
      }).client,
      root,
    ).sync(connectionId)
    await expect(readFile(join(root, 'oryh-skill-sync/SKILL.md'), 'utf8')).rejects.toThrow()
    expect(result.skills).toEqual(['oryh-timesheet-submit'])
  })

  it('refuses a server name that would escape the skills directory, writing nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    for (const name of ['../escaped.md', 'oryh-acme/../../escaped.md', '/etc/passwd', 'a\\b.md']) {
      expect(() => resolveEntry(root, name)).toThrow(/unsafe name|outside the skills directory/)
    }
    const service = new SkillBundleService(
      oryh({ 'oryh-ok': { 'SKILL.md': 'ok' }, '..': { 'SKILL.md': 'no' } }).client,
      root,
    )
    await expect(service.sync(connectionId)).rejects.toThrow(/unsafe name/)
    await expect(readFile(join(root, 'oryh-ok/SKILL.md'), 'utf8')).rejects.toThrow()
    const nested = new SkillBundleService(
      oryh({ 'oryh-ok': { 'SKILL.md': 'ok', '../../escaped.md': 'no' } }).client,
      root,
    )
    await expect(nested.sync(connectionId)).rejects.toThrow(/unsafe name/)
    await expect(readFile(join(root, 'oryh-ok/SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('rejects an empty skill list rather than wiping the installed skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    await new SkillBundleService(oryh({ 'oryh-timesheet-submit': { 'SKILL.md': 'hours' } }).client, root).sync(
      connectionId,
    )
    await expect(
      new SkillBundleService(oryh({}, [{ name: 'changed' }]).client, root).sync(connectionId),
    ).rejects.toThrow(/没有通过 MCP 提供任何技能/)
    expect(await readFile(join(root, 'oryh-timesheet-submit/SKILL.md'), 'utf8')).toBe('hours')
  })

  it('replaces the skills when their holder changes, even under an identical manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    const alice = {
      origin: 'https://oryh.example',
      tenantId: 't',
      userId: 'alice',
      employeeId: 'e1',
      tenantName: 'Acme',
      email: 'alice@example.invalid',
    }
    let holder = alice
    const service = new SkillBundleService(
      oryh({ 'oryh-timesheet-submit': { 'SKILL.md': 'hours' } }).client,
      root,
      async () => holder,
    )
    expect((await service.sync(connectionId)).principal).toEqual(alice)
    expect(service.installedPrincipal()).toEqual(alice)
    expect((await service.sync(connectionId)).installed).toBe(false)
    // Two people in one tenant can hold exactly the same skills, but each person's skills speak for
    // that person, so switching accounts must still replace them.
    holder = { ...alice, userId: 'bob', employeeId: 'e2', email: 'bob@example.invalid' }
    expect((await service.sync(connectionId)).installed).toBe(true)
    expect(JSON.parse(await readFile(join(root, '.oryh-manifest.json'), 'utf8')).principal.userId).toBe('bob')
    // A fresh service reads the holder back from disk rather than guessing.
    const reopened = new SkillBundleService(oryh({}).client, root, async () => holder)
    expect(reopened.installedPrincipal()).toBeUndefined()
    await vi.waitFor(() => expect(reopened.installedPrincipal()?.userId).toBe('bob'))
  })

  it('reinstalls once when the last install recorded no holder, so the holder becomes known', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oryh-skills-'))
    const server = oryh({ 'oryh-timesheet-submit': { 'SKILL.md': 'hours' } })
    await new SkillBundleService(server.client, root).sync(connectionId)
    const holder = {
      origin: 'https://oryh.example',
      tenantId: 't',
      userId: 'alice',
      employeeId: null,
      tenantName: 'Acme',
      email: 'alice@example.invalid',
    }
    const upgraded = new SkillBundleService(server.client, root, async () => holder)
    expect((await upgraded.sync(connectionId)).installed).toBe(true)
    expect((await upgraded.sync(connectionId)).installed).toBe(false)
  })
})
