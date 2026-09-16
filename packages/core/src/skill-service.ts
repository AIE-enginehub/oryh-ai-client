import type { ConnectionId } from './brand.js'
import { samePrincipal, type SkillPrincipal, type SkillSyncResult, type SkillBundleService } from './skill-bundle.js'

/** Browser-safe MCP refresh result; remote skills have no installation directory. */
export interface McpSkillRefreshResult {
  readonly delivery: 'mcp'
  readonly skills: readonly string[]
  readonly message: string
}
export type SkillRefreshResult = SkillSyncResult | McpSkillRefreshResult

/** Host capability, independent of ZIP files, MCP transport, and credentials. */
export interface OryhSkillService {
  readonly delivery: 'bundle' | 'mcp'
  readonly syncDescription: string
  identityContext(expected?: SkillPrincipal): string
  sync(connectionId: ConnectionId, force?: boolean): Promise<SkillRefreshResult>
}

/** Keeps desktop installation and holder checks behind the same capability seam. */
export function desktopSkillService(bundle: Pick<SkillBundleService, 'sync' | 'installedPrincipal'>): OryhSkillService {
  return {
    delivery: 'bundle',
    syncDescription: '通过 MCP 重新从 ORYH 获取并安装本会话企业的技能。用户要求更新或同步技能时调用；oryh-skill-identity 说技能与本会话企业身份不一致时，写入前也先调用。不改任何业务数据；不要自己下载技能。',
    sync: (id, force) => bundle.sync(id, force),
    identityContext(expected) {
      const holder = bundle.installedPrincipal()
      if (holder === undefined) return '正在读取本机 ORYH 技能包属于哪个账号；按 skill 写入前请再核对一次。'
      if (holder === null) return '本机的 ORYH 技能包没有记录属于哪个账号（尚未安装，或由旧版本安装）；按 skill 写入前先调用 oryh_skill_sync。'
      const who = `${holder.tenantName} · ${holder.email}`
      if (!expected) return `本机的 ORYH 技能包属于：${who}。按 skill 执行的业务都以这个身份进行。`
      return samePrincipal(holder, expected)
        ? `本机的 ORYH 技能包属于：${who}，与本会话关联的企业身份一致。`
        : `本机的 ORYH 技能包属于：${who}，与本会话关联的企业身份不一致。不要按 skill 写入；先调用 oryh_skill_sync 同步本会话企业的技能包。`
    },
  }
}
