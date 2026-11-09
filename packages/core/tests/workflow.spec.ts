import { describe, expect, it } from 'vitest'
import { WorkflowDefinitions } from '../src/workflow.js'

/** A transport stand-in that records what was asked and answers with canned rows. */
function http(answer: (path: string) => unknown) {
  const paths: string[] = []
  return {
    paths,
    client: {
      request: async (_id: unknown, r: { path: string }) => {
        paths.push(r.path)
        return answer(r.path)
      },
    } as never,
  }
}

const rows = (data: unknown) => () => ({ data })
const rule = (body: string, kind = 'approval_flow') => ({ kind, body, status: 'published' })

describe('the rules a tenant governs an object type with', () => {
  it('reports an object type as governed only when the tenant published something for it', async () => {
    const transport = http(path =>
      path.includes('timesheet_header') ? { data: [rule('单周合计不少于 30 小时')] } : { data: [] },
    )
    const workflows = new WorkflowDefinitions(transport.client)

    expect(await workflows.governed('c', 'timesheet_header')).toBe(true)
    // Nothing published means nothing to check: a submit must not be blocked for a tenant that runs
    // no flow for this document at all.
    expect(await workflows.governed('c', 'project')).toBe(false)
    expect(await workflows.texts('c', 'timesheet_header')).toEqual(['单周合计不少于 30 小时'])
    // The object type, and that only what is published counts, are pushed to the server.
    expect(transport.paths[0]).toBe('/business-rules?object_type=timesheet_header&status=published&size=100')
  })

  it('reads every kind of rule keyed to the object type, and no company-wide policy', async () => {
    const workflows = new WorkflowDefinitions(
      http(
        rows([
          rule('谁来审批'),
          rule('提交时要满足什么', 'data_rule'),
          rule('到某状态后联动什么', 'linkage'),
          rule('差旅标准', 'policy'),
        ]),
      ).client,
    )
    expect(await workflows.texts('c', 'expense_claim')).toEqual(['谁来审批', '提交时要满足什么', '到某状态后联动什么'])
  })

  it('treats a failed lookup as governed, so a network blip cannot switch the gate off', async () => {
    const workflows = new WorkflowDefinitions({
      request: async () => {
        throw new Error('offline')
      },
    } as never)
    expect(await workflows.governed('c', 'expense_claim')).toBe(true)
    await expect(workflows.texts('c', 'expense_claim')).rejects.toThrow('offline')
  })

  it('caches within its window and goes back to the server once it lapses', async () => {
    const transport = http(rows([rule('规则')]))
    const workflows = new WorkflowDefinitions(transport.client, 0)
    await workflows.governed('c', 'sales_order')
    await workflows.governed('c', 'sales_order')
    // A zero window means every ask is a fresh read; an admin publishing a rule must land at once.
    expect(transport.paths).toHaveLength(2)

    const cached = new WorkflowDefinitions(transport.client, 60_000)
    await cached.governed('c', 'sales_order')
    await cached.governed('c', 'sales_order')
    expect(transport.paths).toHaveLength(3)
    // Different object types are separate questions and must not share an answer.
    await cached.governed('c', 'purchase_request')
    expect(transport.paths).toHaveLength(4)
  })
})
