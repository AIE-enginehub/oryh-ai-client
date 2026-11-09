import {
  BusinessPage,
  type ListHandle,
  OpenInConsole,
  type PageFace,
  type PageOwnerProps,
  PreferenceDetails,
  RecordFields,
  useCommand,
} from '@oryh/ai-client-kit'
import type { ReactNode } from 'react'
import type { TodosApi } from './api.js'
import { TodoChat } from './todo-chat.js'
import type { Words } from './words.js'

/** The open todo's linked document beside the list, and the agent's way of opening one by position. */
function TodoListBridge({
  face,
  api,
  list,
  active,
  t,
}: {
  face: PageFace
  api: TodosApi
  list: ListHandle
  active: boolean
  t: Words
}): ReactNode {
  const { navigate } = face.frame
  // The agent opens a todo by its position in the list the person sees; a list that moved on is refused.
  useCommand(
    face,
    'navigation',
    'my-open-todos',
    command => {
      if (command.target !== 'todo' || !command.todoId || !active) return false
      if (command.listRevision !== list.listRevision || !list.visibleRows.some(row => row.id === command.todoId))
        return false
      list.openRecord(command.todoId)
      // Opened in place; asked to show it, the business view comes forward on a narrow screen too.
      if (command.reveal === true) navigate('my-open-todos', true)
      return true
    },
    [active, list.listRevision, list.visibleRows, navigate],
  )
  return active && list.selected ? <TodoChat face={face} api={api} todoId={list.selected.id} t={t} /> : null
}

/** My open todos: the operation list, the linked document of the open one, and the summary Chat reads. */
export function TodoPage({ face, api, t }: { face: PageFace & PageOwnerProps; api: TodosApi; t: Words }): ReactNode {
  const { connection, active, onContext } = face
  const frameT = face.frame.t
  return (
    <BusinessPage
      face={face}
      connection={connection}
      operationId="my-open-todos"
      resource="todos"
      title={frameT('text8')}
      active={active}
      defaultStatus="open"
      onContext={onContext}
      extraContext={list => ({
        todos: {
          visibleTodos: list.visibleRows.map(row => ({ id: row.id, title: row.title })),
          listRevision: list.listRevision,
          ...(list.selected ? { todoId: list.selected.id } : {}),
        },
      })}
      renderDetail={list => (
        <PreferenceDetails face={face} preferenceKey="my-open-todos:section0">
          <summary>{t('todoSummary')}</summary>
          <RecordFields t={frameT} record={list.selected!} />
          <OpenInConsole t={frameT} connection={connection} record={list.selected!} />
        </PreferenceDetails>
      )}
    >
      {list => <TodoListBridge face={face} api={api} list={list} active={active} t={t} />}
    </BusinessPage>
  )
}
