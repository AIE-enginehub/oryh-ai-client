/** How a status reads at a glance: waiting on someone, or settled. */
export type StatusTone = 'pending' | 'neutral'

/**
 * What a status word reads as, on every page.
 *
 * In ORYH a state name is the tenant's vocabulary: a workspace may rename a shipped state or add its
 * own, and the state machine carries no display words. So this translates only the names ORYH ships in
 * its default machines, for the documents this client shows, and shows any other state exactly as the
 * tenant named it. What it does guarantee is that one name reads the same on every page — no list calls
 * `approved` 「已批准」 while another says 「已通过」. Words follow the approver's own buttons
 * (通过 / 拒绝 / 退回修改).
 */
const words: Readonly<Record<string, string>> = {
  draft: '草稿', submitted: '已提交', approved: '已通过', rejected: '已拒绝', returned: '已退回', cancelled: '已取消',
  commented: '已评论', paid: '已支付', confirmed: '已确认', packed: '已打包', shipped: '已发货', signed: '已签收',
  received: '已收货', open: '待处理', completed: '已完成', closed: '已关闭', active: '进行中', archived: '已归档',
}

/**
 * @param status - a status as the server sent it.
 * @returns its display word; an unknown status shows as it came rather than borrowing another's meaning.
 */
export function statusLabel(status: string): string {
  return Object.hasOwn(words, status) ? words[status]! : status
}

/** Statuses that wait on someone — an approver, or the person themselves. */
const waiting = new Set(['submitted', 'open'])

/** @param status - a status as the server sent it. */
export function statusTone(status: string): StatusTone {
  return waiting.has(status) ? 'pending' : 'neutral'
}
