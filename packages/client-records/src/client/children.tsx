/**
 * The tables that hang off a document — an order's lines, its approvals, its attachments — shown under
 * the document's own fields when it is opened from a list.
 *
 * They come from ORYH's `/detail` for that collection, and which tables there are is ORYH's answer: a
 * collection with no detail shows none, and one that grows a table next month shows it the day it does.
 */

import {
  displayField,
  displaySection,
  ErrorNote,
  formatDisplayValue,
  ListLoading,
  type PageFace,
  useServerRefresh,
} from '@oryh/ai-client-kit'
import type { RecordChild } from '@oryh/ai-client-records'
import { useEffect, useState } from 'react'
import type { RecordsApi } from './api.js'
import type { Words } from './words.js'

export function RecordChildren({
  api,
  face,
  t,
  collection,
  id,
}: {
  api: RecordsApi
  face: PageFace
  t: Words
  collection: string
  id: string
}) {
  const connectionId = face.connection.id
  const [children, setChildren] = useState<RecordChild[]>(),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0)
  useServerRefresh(face, true, () => setReload(value => value + 1))
  useEffect(() => {
    let live = true
    setChildren(undefined)
    setError('')
    api.recordDetail(connectionId, collection, id).then(
      detail => {
        if (live) setChildren(detail.children)
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : t('childrenReadFailed'))
      },
    )
    return () => {
      live = false
    }
  }, [api, connectionId, collection, id, reload])
  if (error) return <ErrorNote face={face} message={error} onRetry={() => setReload(v => v + 1)} />
  if (!children) return <ListLoading t={face.frame.t} label={t('childrenLoading')} />
  return (
    <>
      {children.map(child => (
        <div key={child.key} className="surface document-detail">
          <h2>
            {t('childrenTitle', {
              label: displaySection(face.frame.t, child.key, child.label),
              count: child.rows.length,
            })}
          </h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {child.columns.map(c => (
                    <th scope="col" key={c.field}>
                      {displayField(face.frame.t, c.field, c.label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {child.rows.map((row, index) => (
                  <tr key={row.id || index}>
                    {child.columns.map(c => (
                      <td key={c.field}>{formatDisplayValue(row[c.field] || '—')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  )
}
