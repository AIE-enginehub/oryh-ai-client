import type { OryhProjectRemote } from '@oryh/ai-client-projects'
import { PaneService, UserViewRegistry } from '@oryh/dsh-pane'
import {
  connectionId,
  fakeContext,
  fakeController,
  paneSyncer,
  pending,
  tempDirectory,
  until,
} from '@oryh/dsh-pane/testing'
import type { FormCommand, NavigationCommand } from '@oryh/dsh-pane/types'
import { describe, expect, it, vi } from 'vitest'
import { ProjectChat } from '../src/project-chat.js'
import { configureProjectColumns } from '../src/project-columns.js'

const fields = { project_name: 'Project', project_code: '', client: 'Client', start_date: '', end_date: '' }

async function fixture() {
  const temp = await tempDirectory()
  const harness = fakeContext()
  const prepare = vi.fn(),
    confirm = vi.fn()
  const pane = new PaneService(
    harness.ctx,
    fakeController().controller,
    temp.directory,
    new UserViewRegistry(harness.ctx),
  )
  const chat = new ProjectChat(
    harness.ctx,
    {
      projectOptions: async () => ({ canCreate: true }),
      projectPrepare: prepare,
      projectConfirm: confirm,
    } as unknown as OryhProjectRemote,
    pane,
  )
  await pane.bind({ sessionId: 's', connectionId })
  const page = paneSyncer(pane)
  const showing = (next = fields, busy = false) => ({
    key: 'list-projects:new',
    title: '项目',
    detail: '',
    scope: '',
    project: { fields: next, busy },
  })
  const revision = page.sync('list-projects', showing())
  return {
    chat,
    pane,
    page,
    showing,
    revision,
    prepare,
    confirm,
    pending: () => pane.queue.peek('s', 'form') as FormCommand | undefined,
    fill: (rev: number, next: unknown) => chat.fill('s', rev, next, new AbortController().signal),
    close: temp.close,
  }
}

describe('project chat proposals', () => {
  it('only updates local fields and waits for the page to apply them', async () => {
    const f = await fixture()
    try {
      const next = { ...fields, project_name: 'Updated' }
      const filling = f.fill(f.revision, next)
      await until(() => f.pending() !== undefined)
      expect(f.pending()!.payload).toEqual({ kind: 'project', revision: f.revision, fields: next })
      f.page.ack('form', 'list-projects', f.showing(next))
      expect(await filling).toContain('尚未创建')
      expect(f.pending()).toBeUndefined()
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  it('rejects stale revisions, busy forms, extra metadata and leaving the page', async () => {
    const f = await fixture()
    try {
      await expect(f.fill(0, fields)).rejects.toThrow()
      await expect(f.fill(f.revision, { ...fields, metadata: { tenant: 'other' } })).rejects.toThrow()
      const busy = f.page.sync('list-projects', f.showing(fields, true))
      await expect(f.fill(busy, fields)).rejects.toThrow()
      f.page.sync('timesheets')
      await expect(f.chat.read('s')).rejects.toThrow(/项目页面/)
    } finally {
      await f.close()
    }
  })
  it('does not claim an update if the user changes the form first', async () => {
    const f = await fixture()
    try {
      const filling = f.fill(f.revision, { ...fields, client: 'AI' })
      await until(() => f.pending() !== undefined)
      f.page.sync('list-projects', f.showing({ ...fields, client: 'Human' }))
      await expect(filling).rejects.toThrow(/用户已修改/)
      expect(f.pending()).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('opens the blank form and settles once the page shows one', async () => {
    const f = await fixture()
    try {
      f.page.sync('list-projects', { key: 'list-projects:list', title: '项目', detail: '', scope: '' })
      const opening = f.chat.openProject('s', new AbortController().signal)
      await until(() => f.pane.queue.peek('s', 'navigation') !== undefined)
      expect(f.pane.queue.peek('s', 'navigation')?.payload).toMatchObject({ target: 'project', page: 'list-projects' })
      f.page.ack('navigation', 'list-projects', f.showing())
      expect(await opening).toContain('新建项目表单已打开')
    } finally {
      await f.close()
    }
  })
})

describe('project list columns', () => {
  it('changes project columns only after a matching acknowledgement', async () => {
    const f = await fixture()
    const navigation = () => pending(f.pane) as NavigationCommand | undefined
    try {
      const context = { key: 'list-projects:list', title: '项目', detail: '', scope: '', columns: ['name', 'status'] }
      f.page.sync('list-projects', context)
      await expect(
        configureProjectColumns(f.pane, 's', ['name', 'password'], new AbortController().signal),
      ).rejects.toThrow(/列配置/)
      const changing = configureProjectColumns(f.pane, 's', ['name', 'createdAt'], new AbortController().signal)
      await until(() => navigation() !== undefined)
      f.page.ack('navigation', 'list-projects', { ...context, columns: ['name', 'createdAt'] })
      expect(await changing).toContain('显示列已更新')
      f.page.sync('timesheets')
      await expect(configureProjectColumns(f.pane, 's', ['name'], new AbortController().signal)).rejects.toThrow(
        /项目列表/,
      )
    } finally {
      await f.close()
    }
  })
})
