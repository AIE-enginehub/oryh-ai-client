import type { OryhProject } from '@oryh/ai-client-core/types'
import {
  formatDateTime,
  RowOpenCell,
  RowOpenHeader,
  StatusPill,
  statusLabel,
  statusTone,
} from '@oryh/dsh-client-frame/client'
import type { ProjectColumn } from '@oryh/dsh-projects/types'
import { projectColumnLabels } from './project-column-catalog.js'

export { defaultProjectColumns, projectColumnLabels } from './project-column-catalog.js'
export function ProjectTable({
  projects,
  columns,
  onOpen,
}: {
  projects: OryhProject[]
  columns: ProjectColumn[]
  onOpen: (id: string) => void
}) {
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">项目</caption>
        <thead>
          <tr>
            {columns.map(c => (
              <th scope="col" key={c}>
                {projectColumnLabels[c]}
              </th>
            ))}
            <RowOpenHeader />
          </tr>
        </thead>
        <tbody>
          {projects.map(p => (
            <tr key={p.id}>
              {columns.map(c => (
                <td key={c}>
                  {c === 'name' ? (
                    <button className="record-link" data-row-id={p.id} onClick={() => onOpen(p.id)}>
                      {p.name}
                    </button>
                  ) : c === 'status' ? (
                    <StatusPill tone={statusTone(p.status)}>{statusLabel(p.status)}</StatusPill>
                  ) : (c === 'createdAt' || c === 'updatedAt') && p[c] ? (
                    <time dateTime={p[c]!}>{formatDateTime(p[c]!)}</time>
                  ) : (
                    p[c] || '—'
                  )}
                </td>
              ))}
              <RowOpenCell title={p.name} onOpen={() => onOpen(p.id)} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
