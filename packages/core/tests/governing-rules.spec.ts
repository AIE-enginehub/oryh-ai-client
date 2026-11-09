import { governingTexts, OryhClientError } from '@oryh/ai-client-foundation'
import { describe, expect, it } from 'vitest'

/** An ORYH that answers some paths and has never heard of the rest. */
function oryh(answers: Record<string, unknown[] | Error>) {
  const asked: string[] = []
  const rows = async (path: string) => {
    asked.push(path)
    const answer = answers[path.split('?')[0]!]
    if (answer === undefined) throw new OryhClientError('ORYH request failed with status 404.', 'request-failed', 404)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { asked, rows }
}

describe("a tenant's rules for one kind of document", () => {
  it('are its published business rules keyed to that object type', async () => {
    const server = oryh({
      '/business-rules': [
        { kind: 'approval_flow', body: '单周超过 40 小时需财务经理复核。' },
        { kind: 'data_rule', body: '每天不超过 12 小时。' },
        // A policy belongs to no object type, and a rule with nothing written says nothing.
        { kind: 'policy', body: '差旅标准' },
        { kind: 'linkage', body: '' },
        null,
      ],
    })
    expect(await governingTexts(server.rows, 'timesheet_header', 'builtin')).toEqual([
      '单周超过 40 小时需财务经理复核。',
      '每天不超过 12 小时。',
    ])
    expect(server.asked).toEqual(['/business-rules?entity_kind=builtin&object_type=timesheet_header&status=published'])
  })

  it('are none where the tenant keeps none, and a read that fails is a failure', async () => {
    expect(await governingTexts(oryh({ '/business-rules': [] }).rows, 'purchase_request')).toEqual([])
    const down = oryh({
      '/business-rules': new OryhClientError('ORYH 服务暂时不可用（HTTP 503），请稍后重试。', 'request-failed', 503),
    })
    await expect(governingTexts(down.rows, 'timesheet_header')).rejects.toThrow(/503/)
  })

  it('are not looked for where an earlier ORYH kept them', async () => {
    // An ORYH from before its rules were one table: workflow definitions, and nothing at the new path.
    const earlier = oryh({ '/workflow-definitions': [{ definition_text: '销售部由部门经理审批。', status: 'active' }] })
    await expect(governingTexts(earlier.rows, 'expense_claim')).rejects.toMatchObject({ status: 404 })
    // Its answer is the answer. This client keeps no way back to the path that server still has.
    expect(earlier.asked).toEqual(['/business-rules?object_type=expense_claim&status=published'])
  })
})
