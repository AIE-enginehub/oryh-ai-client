/** Projects as a page plugin: the project list with its columns and the new-project form, over `oryhProjects`. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { OryhProject } from '@oryh/ai-client-core/types'
import {
  type BridgeOwnerProps,
  Button,
  columnPreference,
  columnPreferenceScope,
  type PageOwnerProps,
  PreferenceDetails,
  useColumnPreference,
  useCommand,
} from '@oryh/dsh-client-frame/client'
import { TYPERT_REMOTE } from '@oryh/dsh-projects/remote'
import type { ProjectColumn } from '@oryh/dsh-projects/types'
import { IconFolder } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { createProjectsApi, ProjectsApiContext } from './api.js'
import { defaultProjectColumns, projectCatalog, projectColumnLabels } from './project-column-catalog.js'
import { ProjectTable } from './project-columns.js'
import { ProjectPanel } from './projects.js'

export const inject = ['slots', 'remote', 'locale', 'oryhClientPages']

/** The column picker under the list's filters. */
export function ProjectColumnPicker({
  columns,
  onColumns,
}: {
  columns: ProjectColumn[]
  onColumns: (columns: ProjectColumn[]) => void
}): ReactNode {
  return (
    <PreferenceDetails preferenceKey="list-projects:section2" className="advanced-filters">
      <summary>显示列</summary>
      <div className="project-column-options">
        {(Object.keys(projectColumnLabels) as ProjectColumn[]).map(c => (
          <label key={c}>
            <input
              type="checkbox"
              checked={columns.includes(c)}
              disabled={c === 'name'}
              onChange={e => onColumns(e.target.checked ? [...columns, c] : columns.filter(k => k !== c))}
            />
            {projectColumnLabels[c]}
          </label>
        ))}
        <Button appearance="subtle" size="small" onClick={() => onColumns([...defaultProjectColumns])}>
          恢复默认列
        </Button>
      </div>
    </PreferenceDetails>
  )
}

/** The project list page: the operation list with the person's columns, and the new-project form. */
function ProjectPage({ connection, active, onDirtyChange, onContext }: PageOwnerProps): ReactNode {
  const [columns, setColumns] = useColumnPreference(connection, 'list-projects', projectCatalog)
  const typed = columns as ProjectColumn[]
  return (
    <ProjectPanel
      connection={connection}
      active={active}
      onDirtyChange={onDirtyChange}
      onContext={onContext}
      columns={typed}
      onColumns={setColumns}
      renderTable={list => (
        <ProjectTable
          columns={typed}
          projects={list.visibleRows.map(
            row => (list.result?.result.data as OryhProject[]).find(p => p.id === row.id)!,
          )}
          onOpen={list.openRecord}
        />
      )}
      filters={<ProjectColumnPicker columns={typed} onColumns={setColumns} />}
    />
  )
}

/**
 * Column changes the agent asks for land in the preference store whether or not the list is open;
 * opening the form is the list's own to acknowledge, once it shows it.
 */
function ProjectBridge({ connection, navigate }: BridgeOwnerProps): ReactNode {
  useCommand(
    'navigation',
    undefined,
    command => {
      if (command.target === 'columns' && command.page === 'list-projects' && command.columns) {
        columnPreference(columnPreferenceScope(connection), 'list-projects', projectCatalog).set(command.columns)
        return true
      }
      if (command.target === 'project') {
        navigate('list-projects')
        return false
      }
      return false
    },
    [connection, navigate],
  )
  return null
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE)
  await ctx.inject(['remote.oryhProjects'], ctx => {
    const api = createProjectsApi(ctx.remote)
    const t = ctx.locale.bind('oryh')
    ctx.effect(
      () =>
        ctx.oryhClientPages.register({ page: 'list-projects', order: 40, icon: IconFolder, label: () => t('text12') }),
      'oryh projects menu',
    )
    ctx.slots.inject('oryh.page', () =>
      ctx.slots.register({ name: 'oryh.page', key: 'list-projects' }, props => (
        <ProjectsApiContext.Provider value={api}>
          <ProjectPage {...props} />
        </ProjectsApiContext.Provider>
      )),
    )
    ctx.slots.inject('oryh.bridge', () => ctx.slots.register({ name: 'oryh.bridge', id: 'projects' }, ProjectBridge))
  })
}
