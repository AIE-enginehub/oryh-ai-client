import { LocalRemoteError } from '@oryh/ai-client-kit'
import { retryDelay } from './permission-check.js'

/** Retry only the read-only startup load when the Gateway carrier failed to answer. */
export async function restoreStartupConnection<T>(
  load: () => Promise<T>,
  signal: AbortSignal,
  retrying: () => void,
): Promise<T> {
  let failures = 0
  while (true) {
    signal.throwIfAborted()
    try {
      const result = await load()
      signal.throwIfAborted()
      return result
    } catch (reason) {
      signal.throwIfAborted()
      // Host business refusals (including denied Keychain access) are final here.
      // The public Gateway folds an unanswered/failed carrier into gateway/internal.
      if (!(reason instanceof LocalRemoteError) || reason.business || reason.code !== 'gateway/internal') throw reason
      retrying()
      await pause(retryDelay(++failures), signal)
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancelled)
      resolve()
    }, ms)
    signal.addEventListener('abort', cancelled, { once: true })
  })
}
