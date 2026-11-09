/** Product guidance in the public conversation renderer, retaining upstream behavior for other failures. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TurnErrorNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { OryhKey, OryhText } from '@oryh/ai-client-kit'
import type { ComponentType } from 'react'

export function modelFailureKey(code: string | undefined): OryhKey | undefined {
  switch (code) {
    case 'MISSING_CREDENTIAL':
      return 'modelMissingKey'
    case 'INVALID_CREDENTIAL':
    case 'AUTH':
      return 'modelInvalidKey'
    case 'NO_ADAPTER':
    case 'UNKNOWN_MODEL':
      return 'modelUnavailable'
    default:
      return undefined
  }
}

export function ModelFailure({ code, t }: { code: string | undefined; t: OryhText }) {
  const key = modelFailureKey(code)
  if (!key) return null
  return (
    <div className="oryh-model-error" role="status">
      <strong>{t('modelSetupRequired')}</strong>
      <span>{t(key)}</span>
      <small>{t('modelSetupPath')}</small>
    </div>
  )
}

export function registerModelErrors(ctx: Context): void {
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'turn-error', priority: -100, locale: 'oryh' },
      function ProductTurnError(props) {
        const data = props.node.data as TurnErrorNode
        if (modelFailureKey(data.code)) return <ModelFailure code={data.code} t={props.t} />
        // Preserve quota, stopped-turn, retry and generic error presentation supplied by Harness.
        const native = ctx.slots
          .entries('conversation.chat.node')
          .find(entry => entry.options.key === 'turn-error' && entry.options.priority !== -100)
        if (!native) return <div role="status">{data.message}</div>
        const Native = native.component as ComponentType<Record<string, unknown>>
        return <Native {...props} t={ctx.locale.bind('chat')} />
      },
    ),
  )
}
