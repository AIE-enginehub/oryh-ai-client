import type { PageId } from '@oryh/ai-client-pages'
import type { TimesheetAction } from '@oryh/ai-client-timesheets'
import { BusinessSessionContext, Button, useCommand, usePane, usePaneAck } from '@oryh/dsh-client-frame/client'
import type { AnyPaneCommand } from '@oryh/dsh-pane/types'
import { useContext, useState } from 'react'

/** Chat fills the form on screen; saving, submitting and approving happen in the conversation itself (ADR-0010). */
const titles: Partial<Record<TimesheetAction['kind'], string>> = {
  update: '修改整张工时表单',
  create: '填写工时表单',
  'add-line': '添加工时明细',
  'edit-line': '修改工时明细',
  'delete-line': '删除工时明细',
}
const wholeForm = (action: TimesheetAction) => action.kind === 'create' || action.kind === 'update'

/**
 * What Chat proposes for the timesheet form on screen, and how the link to Chat stands.
 *
 * A whole-form fill is applied at once while the page is free; a line suggestion is shown for the
 * person to apply or ignore. Either way the command is acknowledged to the Host only when the page
 * has acted on it, which is what the agent's tool waits for.
 */
export function TimesheetChat({
  page,
  busy,
  dirty,
  onApply,
}: {
  page: PageId
  busy: boolean
  dirty: boolean
  onApply: (action: TimesheetAction) => void
}) {
  const sessionId = useContext(BusinessSessionContext)
  const { status, error } = usePane()
  const ack = usePaneAck()
  const [proposal, setProposal] = useState<{ command: AnyPaneCommand; action: TimesheetAction }>()
  const [applied, setApplied] = useState(false)
  useCommand(
    'form',
    page,
    (payload, command) => {
      if (payload.kind !== 'timesheet') return false
      if (wholeForm(payload.action)) {
        if (busy) return false
        onApply(payload.action)
        setApplied(true)
        return true
      }
      setProposal({ command, action: payload.action })
      // Acknowledged by the person, when they apply or ignore it.
      return false
    },
    [busy, onApply],
  )
  const message = !sessionId
    ? '请在 Chat 中选择或新建会话，即可通过 Chat 填写工时。'
    : status === 'rejected'
      ? (error ?? 'Chat 关联失败')
      : status === 'synced'
        ? applied
          ? 'Chat 已更新未保存表单，可继续描述要修改的内容。'
          : 'Chat 已关联'
        : status === 'reconnecting'
          ? '正在重新连接 Chat…'
          : '正在关联工时页面…'
  const p = proposal
  const settle = () => {
    if (!p) return
    ack(p.command.lane, p.command.id)
    setProposal(undefined)
  }
  return (
    <div className="oryh-timesheet-chat">
      <div className="chat-context-status">
        <p role="status">{message}</p>
      </div>
      {p && (
        <section className="surface">
          <h2>Chat 建议 · {titles[p.action.kind] ?? '修改工时表单'}</h2>
          <p>这是对中间栏表单的修改建议，应用后仍需在页面保存。</p>
          {p.action.fields && (
            <p>
              {p.action.fields.period_start} — {p.action.fields.period_end}
              <br />
              {p.action.fields.source_report_text}
            </p>
          )}
          {(p.action.fields || p.action.line) && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>小时</th>
                    <th>工作任务</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {(p.action.fields?.entries ?? [p.action.line!]).map((l, i) => (
                    <tr key={i}>
                      <td>{l.work_date}</td>
                      <td>{l.hours}</td>
                      <td>{l.task}</td>
                      <td>{l.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {p.action.headerId && <p>工时编号：{p.action.headerId}</p>}
          <div className="toolbar">
            <Button
              appearance="primary"
              disabled={busy}
              onClick={() => {
                onApply(p.action)
                settle()
              }}
            >
              {wholeForm(p.action) && dirty ? '替换当前表单内容' : '应用到工时表单'}
            </Button>
            <Button disabled={busy} onClick={settle}>
              忽略建议
            </Button>
          </div>
          {dirty && wholeForm(p.action) && <p>当前有未保存修改；应用这条建议会替换当前表单内容。</p>}
        </section>
      )}
    </div>
  )
}
