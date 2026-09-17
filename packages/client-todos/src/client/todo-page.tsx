import {
  BusinessPage,
  OpenInConsole,
  type PageOwnerProps,
  PreferenceDetails,
  RecordFields,
  useCommand,
  useListHandle,
  useText,
} from '@oryh/dsh-client-frame/client'
import type { ReactNode } from 'react'
import { TodoChat } from './todo-chat.js'

/** The open todo's linked document beside the list, and the agent's way of opening one by position. */
function TodoListBridge({
  connection,
  active,
}: {
  connection: PageOwnerProps['connection']
  active: boolean
}): ReactNode {
  const list = useListHandle()
  // The agent opens a todo by its position in the list the person sees; a list that moved on is refused.
  useCommand(
    'navigation',
    'my-open-todos',
    command => {
      if (command.target !== 'todo' || !command.todoId || !active) return false
      if (command.listRevision !== list.listRevision || !list.visibleRows.some(row => row.id === command.todoId))
        return false
      list.openRecord(command.todoId)
      return true
    },
    [active, list.listRevision, list.visibleRows],
  )
  return active && list.selected ? <TodoChat connectionId={connection.id} todoId={list.selected.id} /> : null
}

/** My open todos: the operation list, the linked document of the open one, and the summary Chat reads. */
export function TodoPage({ connection, active, onContext }: PageOwnerProps): ReactNode {
  const t = useText()
  return (
    <BusinessPage
      connection={connection}
      operationId="my-open-todos"
      title={t('text8')}
      active={active}
      onContext={onContext}
      extraContext={list => ({
        todos: {
          visibleTodos: list.visibleRows.map(row => ({ id: row.id, title: row.title })),
          listRevision: list.listRevision,
          ...(list.selected ? { todoId: list.selected.id } : {}),
        },
      })}
      renderDetail={list => (
        <PreferenceDetails preferenceKey="my-open-todos:section0">
          <summary>待办摘要与原系统入口</summary>
          <RecordFields record={list.selected!} />
          <OpenInConsole connection={connection} record={list.selected!} />
        </PreferenceDetails>
      )}
    >
      <TodoListBridge connection={connection} active={active} />
    </BusinessPage>
  )
}
