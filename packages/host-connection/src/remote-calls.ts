import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type {} from './types.js'

/**
 * What every ORYH Remote namespace shares: requests are refused once the plugin is unloading, the
 * ones in flight are awaited before it goes, and a business failure crosses the Gateway as
 * `oryh/business` with its code, while anything else becomes one safe message.
 *
 * A helper rather than a base class: the typert generator models a Remote's heritage, and a base
 * class between the Remote and `TypertRemoteService` is a shape it does not read.
 */
export class RemoteCalls {
  #closed = false
  readonly #active = new Set<Promise<unknown>>()

  constructor(ctx: Context, namespace: string) {
    ctx.effect(
      () => async () => {
        this.#closed = true
        await Promise.allSettled([...this.#active])
      },
      `${namespace} pending requests`,
    )
  }

  async call<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.#closed) throw new RemoteError('oryh/business', 'ORYH 插件已卸载。', { code: 'request-failed' })
    const pending = Promise.resolve().then(action)
    this.#active.add(pending)
    try {
      return await pending
    } catch (error) {
      if (error instanceof OryhClientError) throw new RemoteError('oryh/business', error.message, { code: error.code })
      throw new RemoteError('oryh/business', 'ORYH 无法完成请求，请重试。', { code: 'request-failed' })
    } finally {
      this.#active.delete(pending)
    }
  }
}
