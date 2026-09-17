import { hasPermission } from '@oryh/ai-client-pages'
import {
  BusinessPage,
  Button,
  NewButton,
  type PageContext,
  type PageOwnerProps,
  useBusinessText,
  useText,
  useViewPreference,
} from '@oryh/dsh-client-frame/client'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { ExpensePanel } from './expenses.js'

const expenseTabPreference = z.enum(['list', 'drafts']).catch('list')

/**
 * Expense claims: the claim list from ORYH, and the local drafts editor beside it, under one title.
 * The drafts view is only offered to someone who may keep drafts at all.
 */
export function ExpensePage({ connection, active, onDirtyChange, onContext }: PageOwnerProps): ReactNode {
  const t = useText()
  const text = useBusinessText()
  const [savedTab, setTab] = useViewPreference<'list' | 'drafts'>('expenseTab', 'list', expenseTabPreference)
  const mayDraft = hasPermission(connection.identity, 'expense.submit_own')
  const tab = mayDraft ? savedTab : 'list'
  const [draftsVisited, setDraftsVisited] = useState(tab === 'drafts')
  const [newRequest, setNewRequest] = useState(0)
  // Each view reports its own context; the one on screen is what the Host hears.
  const contexts = useRef<{ list?: PageContext; drafts?: PageContext }>({})
  const report = useRef(onContext)
  report.current = onContext
  const publish = () => {
    const current = tab === 'drafts' ? contexts.current.drafts : contexts.current.list
    if (current) report.current(current)
  }
  useEffect(publish, [tab])
  const tabs = mayDraft ? (
    <div className="view-tabs" role="group" aria-label={t('text20')}>
      <Button
        appearance={tab === 'list' ? 'secondary' : 'subtle'}
        aria-pressed={tab === 'list'}
        onClick={() => setTab('list')}
      >
        {t('text21')}
      </Button>
      <Button
        appearance={tab === 'drafts' ? 'secondary' : 'subtle'}
        aria-pressed={tab === 'drafts'}
        onClick={() => {
          setTab('drafts')
          setDraftsVisited(true)
        }}
      >
        {t('text22')}
      </Button>
    </div>
  ) : undefined
  return (
    <>
      <div hidden={tab !== 'list'}>
        <BusinessPage
          connection={connection}
          operationId="my-expense-claims"
          title={t('text10')}
          active={active && tab === 'list'}
          onContext={value => {
            contexts.current.list = value
            if (tab === 'list') report.current(value)
          }}
          {...(tabs ? { tabs } : {})}
          secondaryColumn={text('text77')}
          dateLabel={text('text29')}
          actions={
            mayDraft ? (
              <NewButton
                onClick={() => {
                  setTab('drafts')
                  setDraftsVisited(true)
                  setNewRequest(value => value + 1)
                }}
              >
                {text('text57')}
              </NewButton>
            ) : undefined
          }
        />
      </div>
      {draftsVisited && mayDraft && (
        <div hidden={tab !== 'drafts'}>
          <ExpensePanel
            connection={connection}
            active={active && tab === 'drafts'}
            {...(tabs ? { tabs } : {})}
            newRequest={newRequest}
            onDirtyChange={onDirtyChange}
            onContext={value => {
              contexts.current.drafts = value
              if (tab === 'drafts') report.current(value)
            }}
          />
        </div>
      )}
    </>
  )
}
