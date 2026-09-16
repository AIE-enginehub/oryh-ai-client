import type { Context } from '@deepseek-ai/cordis'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
/** Project the public theme snapshot; restore pre-existing DOM values on unload. */
export function presentTheme(ctx: Context): void {
  ctx.effect(() => {
    const body = document.body
    const root = document.documentElement
    const previousScheme = root.style.colorScheme
    const previousDark = body.getAttribute('data-ds-dark-theme')
    const previous = new Map<string, { value: string; priority: string }>()
    let tokens: string[] = []
    const meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta)
    const remember = (key: string) => { if (!previous.has(key)) previous.set(key, { value: body.style.getPropertyValue(key), priority: body.style.getPropertyPriority(key) }) }
    const restore = (key: string) => { const old = previous.get(key); if (old?.value) body.style.setProperty(key, old.value, old.priority); else body.style.removeProperty(key) }
    const apply = (theme: ThemeSnapshot) => {
      root.style.colorScheme = theme.active.colorScheme
      body.toggleAttribute('data-ds-dark-theme', theme.active.colorScheme === 'dark')
      for (const key of tokens) restore(key)
      tokens = Object.keys(theme.active.tokens)
      for (const [key, value] of Object.entries(theme.active.tokens)) { remember(key); body.style.setProperty(key, value) }
      remember('--dsh-content-font-size'); body.style.setProperty('--dsh-content-font-size', `${theme.fontSize}px`)
      meta.content = getComputedStyle(body).backgroundColor
    }
    apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', apply)
    return () => {
      off(); meta.remove(); root.style.colorScheme = previousScheme
      if (previousDark === null) body.removeAttribute('data-ds-dark-theme'); else body.setAttribute('data-ds-dark-theme', previousDark)
      for (const key of previous.keys()) restore(key)
    }
  }, 'oryh theme presentation')
}
