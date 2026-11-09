/**
 * How a state reads on a page. The words themselves are shared with the agent, which is told to speak
 * them too: they live in `@oryh/ai-client-records` (words.ts), and this adds only what a page needs to
 * draw one.
 */
import {
  conditionText,
  fieldLabel,
  fieldLabelFor,
  isStatusField,
  sectionLabel,
  statusLabel,
  statusValue,
  statusWords,
} from '@oryh/ai-client-records'

export { conditionText, fieldLabel, fieldLabelFor, isStatusField, sectionLabel, statusLabel, statusValue, statusWords }

/** How a status reads at a glance: waiting on someone, or settled. */
export type StatusTone = 'pending' | 'neutral'

/** Statuses that wait on someone — an approver, or the person themselves. */
const waiting = new Set(['submitted', 'open'])

/** @param status - a status as the server sent it. */
export function statusTone(status: string): StatusTone {
  return waiting.has(status) ? 'pending' : 'neutral'
}
