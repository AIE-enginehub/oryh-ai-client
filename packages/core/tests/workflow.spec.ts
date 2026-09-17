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

describe('workflow definitions', () => {
  it('reports an object type as governed only when the tenant defined something for it', async () => {
    const transport = http(path =>
      path.includes('timesheet_header')
        ? { data: [{ definition_text: '单周合计不少于 30 小时', status: 'active' }] }
        : { data: [] },
    )
    const workflows = new WorkflowDefinitions(transport.client)

    expect(await workflows.governed('c', 'timesheet_header')).toBe(true)
    // Nothing defined means nothing to check: a submit must not be blocked for a tenant that runs
    // no flow for this document at all.
    expect(await workflows.governed('c', 'project')).toBe(false)
    expect(await workflows.texts('c', 'timesheet_header')).toEqual(['单周合计不少于 30 小时'])
    // The object type is pushed to the server rather than filtered here.
    expect(transport.paths[0]).toContain('object_type=timesheet_header')
  })

  it('skips a definition the tenant switched off, and keeps ones with no status at all', async () => {
    const workflows = new WorkflowDefinitions(
      http(
        rows([
          { definition_text: '旧规则', status: 'archived' },
          { definition_text: '当前规则', status: 'active' },
          { definition_text: '没有 status 字段的部署' },
        ]),
      ).client,
    )
    expect(await workflows.texts('c', 'expense_claim')).toEqual(['当前规则', '没有 status 字段的部署'])
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
    const transport = http(rows([{ definition_text: '规则', status: 'active' }]))
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
