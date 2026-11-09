import {
  Button,
  displayField,
  displaySection,
  displayStatus,
  fieldLabelFor,
  formatDateTime,
  formatDisplayValue,
  type PageFace,
  StatusPill,
  sectionLabel,
  usePane,
  useServerRefresh,
} from '@oryh/ai-client-kit'
import type { TodoDocument } from '@oryh/ai-client-todos'
import { useEffect, useState } from 'react'
import type { TodosApi } from './api.js'
import type { WordKey, Words } from './words.js'

// The names this page alone has a word for, by the key of that word in this plugin's list.
const names: Record<string, WordKey> = {
  todo: 'nameTodo',
  sales_quotation: 'nameSalesQuotation',
  purchase_request: 'namePurchaseRequest',
  purchase_order: 'namePurchaseOrder',
  sales_order: 'nameSalesOrder',
  timesheet_header: 'nameTimesheetHeader',
  expense_claim: 'nameExpenseClaim',
  employee_leave: 'nameEmployeeLeave',
  business_object: 'nameBusinessObject',
  leave_type: 'nameLeaveType',
  from_date: 'nameFromDate',
  thru_date: 'nameThruDate',
  duration_days: 'nameDurationDays',
  quotation: 'nameQuotation',
  request: 'nameRequest',
  po: 'namePo',
  order: 'nameOrder',
  header: 'nameHeader',
  claim: 'nameClaim',
  product: 'nameProduct',
  sku: 'nameSku',
  id: 'nameId',
  employee_id: 'nameEmployeeId',
  title: 'nameTitle',
  description: 'nameDescription',
  entity_type: 'nameEntityType',
  entity_id: 'nameEntityId',
  unpriced_item_count: 'nameUnpricedItemCount',
  pending_sku_count: 'namePendingSkuCount',
  list_price: 'nameListPrice',
  name: 'nameName',
  notes: 'nameNotes',
  task: 'nameTask',
  hours: 'nameHours',
  source_report_text: 'nameSourceReportText',
}
/**
 * What a name on this page is called. The words this page alone has — a kind of document, a field only
 * its documents carry — come first; every other name takes the workbench's shared word, the one the
 * lists and the agent use, and where the document has a page of its own, that page's word for it: a sales
 * order's total is 订单总额 here as it is on the order list. Only what nobody named shows as the API has it.
 * @param t - this plugin's words.
 * @param objectType - the kind of document the name is on.
 */
const labelFor = (t: Words, objectType: string, ui: PageFace['frame']['t']) => (key: string) => {
  const [name, ...suffix] = key.split(' ')
  const own = fieldLabelFor(objectType, name!)
  const word = names[name!]
  const label = word
    ? t(word)
    : own !== name
      ? displayField(ui, name!, own)
      : displaySection(ui, name!, sectionLabel(name!))
  return [label, ...suffix].join(' ')
}
// What identifies and versions a record rather than describing it: kept, but out of the way. The
// revision is a 64-character digest ORYH checks a save against, and it used to head every document.
const isMetadata = (name: string) =>
  name === 'id' ||
  name.endsWith('_id') ||
  name === 'created_at' ||
  name === 'updated_at' ||
  name === 'revision' ||
  name === 'superseded_by'

/**
 * What became of the todo itself, when something has: ORYH completes an approver's todo the moment the
 * approval is recorded, so an approval made in Chat shows here as done, where it was asked for.
 */
function TodoOutcome({ document, t }: { document: TodoDocument; t: Words }) {
  const fields = document.sections.find(s => s.name === 'todo')?.fields ?? []
  const value = (name: string) => fields.find(f => f.name === name)?.value
  const status = value('status'),
    at = value('completed_at')
  if (status === 'completed')
    return (
      <p role="status">
        <StatusPill>{t('todoCompleted')}</StatusPill>
        {at && at !== '—' ? ` ${formatDateTime(at)}` : ''}
      </p>
    )
  if (status === 'cancelled')
    return (
      <p role="status">
        <StatusPill>{t('todoCancelled')}</StatusPill>
      </p>
    )
  return null
}

/**
 * The linked document of the open todo, read through the same authenticated business Remote as the
 * model's read tool, and the state of the pane's link to Chat.
 *
 * Which todo is open reaches Chat through the page's context; nothing here talks to the Host.
 */
export function TodoChat({ face, api, todoId, t }: { face: PageFace; api: TodosApi; todoId: string; t: Words }) {
  const { sessionId } = face.frame
  const connectionId = face.connection.id
  const { status, error: linkError } = usePane(face)
  const [retry, setRetry] = useState(0),
    [document, setDocument] = useState<TodoDocument>(),
    // A failure's own message, or `true` for one that brought none: the word for it is read as it is drawn.
    [error, setError] = useState<string | true>('')
  // The linked document may have been changed in Chat; reading it again is the same re-sync as the button.
  useServerRefresh(face, true, () => setRetry(n => n + 1))
  useEffect(() => {
    let alive = true
    setDocument(undefined)
    setError('')
    void api
      .todoDetail(connectionId, todoId)
      .then(d => {
        if (alive) setDocument(d)
      })
      .catch(e => {
        if (alive) setError(e instanceof Error ? e.message : true)
      })
    return () => {
      alive = false
    }
  }, [api, connectionId, todoId, retry])
  const linked = sessionId !== undefined && status === 'synced'
  const message = !sessionId
    ? t('chatNeedsSession')
    : status === 'rejected'
      ? (linkError ?? t('chatSyncFailed'))
      : status === 'reconnecting'
        ? t('chatReconnecting')
        : t('chatSyncing')
  return (
    <section className="oryh-todo-chat">
      <div className="chat-context-status">
        <p role="status">
          <strong>{linked ? t('chatLinked') : t('chatContext')}</strong>
          {!linked && <> · {message}</>}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setRetry(n => n + 1)}>
          {t('resync')}
        </Button>
      </div>
      {error && <p role="alert">{error === true ? t('detailReadFailed') : error}</p>}
      {document && <TodoOutcome document={document} t={t} />}
      {!document && !error && <p role="status">{t('readingLinkedDocument')}</p>}
      {document && (
        <div className="surface document-detail">
          <h2>{labelFor(t, document.entityType, face.frame.t)(document.entityType)}</h2>
          <p className="data-caption">{t('sourceCaption', { time: formatDateTime(document.fetchedAt) })}</p>
          {document.sections
            .filter(s => s.name !== 'todo')
            .map(s => (
              <details
                key={s.name}
                open={!s.name.includes('/') || /\/(quotation|request|po|order|header|claim)$/.test(s.name)}
              >
                <summary>
                  {s.name
                    .split('/')
                    .map(labelFor(t, document.entityType, face.frame.t))
                    .join(' / ')}
                </summary>
                <dl className="document-fields">
                  {s.fields
                    .filter(f => !isMetadata(f.name))
                    .map(f => (
                      <div key={f.name}>
                        <dt>{labelFor(t, document.entityType, face.frame.t)(f.name)}</dt>
                        <dd>
                          {f.name === 'status' ? displayStatus(face.frame.t, f.value) : formatDisplayValue(f.value)}
                        </dd>
                      </div>
                    ))}
                </dl>
                {s.fields.some(f => isMetadata(f.name)) && (
                  <details className="document-metadata">
                    <summary>{t('metadataSummary')}</summary>
                    <dl className="document-fields">
                      {s.fields
                        .filter(f => isMetadata(f.name))
                        .map(f => (
                          <div key={f.name}>
                            <dt>{labelFor(t, document.entityType, face.frame.t)(f.name)}</dt>
                            <dd>{formatDisplayValue(f.value)}</dd>
                          </div>
                        ))}
                    </dl>
                  </details>
                )}
              </details>
            ))}
        </div>
      )}
    </section>
  )
}
