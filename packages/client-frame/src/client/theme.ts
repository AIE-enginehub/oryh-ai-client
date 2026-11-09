import type { Context } from '@deepseek-ai/cordis'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
/** Project the public theme snapshot; restore pre-existing DOM values on unload. */
export function presentTheme(ctx: Context): void {
  ctx.effect(() => {
    const body = document.body
    const root = document.documentElement
    const previousScheme = root.style.colorScheme
    const previousSource = root.getAttribute('data-ds-theme-source')
    const previousDark = body.getAttribute('data-ds-dark-theme')
    const previous = new Map<string, { value: string; priority: string }>()
    let tokens: string[] = []
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.append(meta)
    const remember = (key: string) => {
      if (!previous.has(key))
        previous.set(key, { value: body.style.getPropertyValue(key), priority: body.style.getPropertyPriority(key) })
    }
    const restore = (key: string) => {
      const old = previous.get(key)
      if (old?.value) body.style.setProperty(key, old.value, old.priority)
      else body.style.removeProperty(key)
    }
    const apply = (theme: ThemeSnapshot) => {
      root.style.colorScheme = theme.active.colorScheme
      root.setAttribute('data-ds-theme-source', theme.preference === 'system' ? 'system' : theme.active.colorScheme)
      body.toggleAttribute('data-ds-dark-theme', theme.active.colorScheme === 'dark')
      for (const key of tokens) restore(key)
      tokens = Object.keys(theme.active.tokens)
      for (const [key, value] of Object.entries(theme.active.tokens)) {
        remember(key)
        body.style.setProperty(key, value)
      }
      for (const role of ['text', 'code', 'terminal'] as const) {
        const size = role === 'text' ? '--dsh-content-font-size' : `--dsh-${role}-font-size`
        const family = `--dsh-font-family-${role}`
        remember(size)
        remember(family)
        body.style.setProperty(size, `${theme.fontSizes[role]}px`)
        if (theme.fontFamilies[role]) body.style.setProperty(family, theme.fontFamilies[role])
        else body.style.removeProperty(family)
      }
      meta.content = getComputedStyle(body).backgroundColor
    }
    apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', apply)
    return () => {
      off()
      meta.remove()
      root.style.colorScheme = previousScheme
      if (previousSource === null) root.removeAttribute('data-ds-theme-source')
      else root.setAttribute('data-ds-theme-source', previousSource)
      if (previousDark === null) body.removeAttribute('data-ds-dark-theme')
      else body.setAttribute('data-ds-dark-theme', previousDark)
      for (const key of previous.keys()) restore(key)
    }
  }, 'oryh theme presentation')
}
