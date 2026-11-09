// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { expect, it } from 'vitest'
import { presentTheme } from './theme.js'

it('presents all three font roles and restores DOM values on unload', () => {
  let change!: (theme: ThemeSnapshot) => void
  let dispose!: () => void
  const snapshot = {
    preference: 'system',
    active: { colorScheme: 'dark', tokens: { '--custom-color': 'red' } },
    fontSizes: { text: 17, code: 14, terminal: 13 },
    fontFamilies: { text: 'Arial', code: 'Menlo', terminal: '' },
  } as ThemeSnapshot
  document.body.style.setProperty('--dsh-terminal-font-size', '12px')
  document.documentElement.setAttribute('data-ds-theme-source', 'light')
  presentTheme({
    effect: (effect: () => () => void) => {
      dispose = effect()
    },
    theme: { getTheme: () => snapshot },
    on: (_name: string, listener: typeof change) => {
      change = listener
      return () => {}
    },
  } as unknown as Context)
  expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('17px')
  expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('14px')
  expect(document.body.style.getPropertyValue('--dsh-font-family-code')).toBe('Menlo')
  expect(document.documentElement.dataset.dsThemeSource).toBe('system')
  expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
  change({
    ...snapshot,
    preference: 'light',
    active: { ...snapshot.active, colorScheme: 'light', tokens: {} },
    fontFamilies: { text: '', code: '', terminal: '' },
  })
  expect(document.body.style.getPropertyValue('--dsh-font-family-code')).toBe('')
  expect(document.body.style.getPropertyValue('--custom-color')).toBe('')
  dispose()
  expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('12px')
  expect(document.documentElement.dataset.dsThemeSource).toBe('light')
  document.body.style.removeProperty('--dsh-terminal-font-size')
  document.documentElement.removeAttribute('data-ds-theme-source')
})
