/**
 * The two shared list pieces that offer 「问 AI」: a failure, and a row.
 *
 * The pieces themselves (`list-kit`) know nothing of Chat; the pairing with 「问 AI」 is made here.
 */
import type { ComponentProps, ReactNode } from 'react'
import { AskAi, errorQuestion } from './ask.js'
import type { PageFace } from './frame.js'
import { ErrorNote as KitErrorNote, RowOpenCell as KitRowOpenCell } from './list-kit.js'

/**
 * Something failed, with a way to ask the agent about it. What went wrong is often ORYH's own sentence,
 * and the agent can say what it means and what to do.
 */
export function ErrorNote({
  face,
  ...props
}: Omit<ComponentProps<typeof KitErrorNote>, 'ask' | 't'> & { face: PageFace }): ReactNode {
  const { message } = props
  return (
    <KitErrorNote
      {...props}
      t={face.frame.t}
      ask={
        typeof message === 'string' && message ? (
          <AskAi face={face} question={errorQuestion(face.frame.t, message)} />
        ) : null
      }
    />
  )
}

/**
 * The trailing ">" that opens a row's detail.
 * @param props.ask - the row's collection and id, where it is a record the agent can read: the row then
 *   carries a 「问 AI」 of its own, and the question says which row it is about.
 */
export function RowOpenCell({
  face,
  ask,
  ...rest
}: Omit<ComponentProps<typeof KitRowOpenCell>, 'ask' | 't'> & {
  face: PageFace
  ask?: { resource: string; id: string } | undefined
}): ReactNode {
  return (
    <KitRowOpenCell
      {...rest}
      t={face.frame.t}
      ask={
        ask ? (
          <AskAi
            face={face}
            compact
            question={face.frame.t('askRecordQuestion')}
            subject={{ title: rest.title, ...ask }}
          />
        ) : null
      }
    />
  )
}
