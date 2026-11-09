/** Private child entry: only the legacy read may wait synchronously for OS consent. */
import { connectionId, KeychainCredentialVault } from '@oryh/ai-client-core'

process.once('message', async (message: unknown) => {
  try {
    if (
      !message ||
      typeof message !== 'object' ||
      !('connectionId' in message) ||
      typeof message.connectionId !== 'string'
    )
      throw new Error('Invalid migration request')
    const credential = await new KeychainCredentialVault().read(connectionId(message.connectionId))
    process.send?.({ ok: true, credential }, () => process.disconnect())
  } catch {
    // Native errors can contain credential material. Only a fixed failure tag crosses IPC.
    process.send?.({ ok: false }, () => process.disconnect())
  }
})
