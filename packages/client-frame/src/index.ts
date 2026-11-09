/** Host loader entry: brand the initial document through the public WebServer extension. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

export interface Config {
  managedSettings?: boolean
}
export const Config: z<Config> = z.object({ managedSettings: z.boolean().default(false) })

export const name = 'oryh-client-frame'

/** Same four-record ORYH mark used by the sidebar; SVG colors follow the browser appearance. */
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><style>svg{color:#11110f}@media(prefers-color-scheme:dark){svg{color:#f4f4f2}}</style><rect x="7" y="4" width="17" height="8" rx="3" fill="currentColor"/><rect x="28" y="9" width="8" height="17" rx="3" fill="currentColor"/><rect x="16" y="28" width="17" height="8" rx="3" fill="#047857"/><rect x="4" y="15" width="8" height="17" rx="3" fill="currentColor"/></svg>`
const iconUrl = `data:image/svg+xml,${encodeURIComponent(icon)}`
const manifest = `data:application/manifest+json,${encodeURIComponent(JSON.stringify({ name: 'ORYH AI Client', short_name: 'ORYH', display: 'standalone', start_url: '/', icons: [{ src: iconUrl, sizes: 'any', type: 'image/svg+xml' }] }))}`

/** Runs before the browser loads, including on the server Profile. No global DOM rewrite is needed. */
export function brandIndex(html: string, managedSettings = false): string {
  const branded = html
    .replace(/<title>[^<]*<\/title>/i, '<title>ORYH AI Client</title>')
    .replace(/<link\b[^>]*\brel=["'](?:icon|shortcut icon|apple-touch-icon|manifest)["'][^>]*>/gi, '')
  return branded.replace(
    /<\/head>/i,
    `<meta name="oryh-managed-settings" content="${managedSettings}"><link rel="icon" type="image/svg+xml" href="${iconUrl}"><link rel="manifest" href="${manifest}"></head>`,
  )
}
export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(['webServer'], child => {
    child.effect(
      () => child.webServer.tapIndex(html => brandIndex(html, config.managedSettings)),
      'oryh initial document brand',
    )
  })
}
