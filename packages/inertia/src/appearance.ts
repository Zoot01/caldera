import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import type { DocumentPart } from './inertia.js'
import { escapeAttribute } from './vite.js'

export type Appearance = 'light' | 'dark' | 'system'
export const APPEARANCES = ['light', 'dark', 'system'] as const

export interface AppearanceOptions {
  /** The cookie the browser keeps the choice in (default `appearance`). Not signed: it's only a preference. */
  cookie?: string
  /**
   * The page background per theme, painted before the stylesheet loads so a dark page never flashes
   * white. Plain CSS colors (the stylesheet's variables don't exist yet). Default: white and #161616.
   */
  background?: { light: string; dark: string }
}

/** This request's choice: the cookie when it holds a known value, otherwise `system`. */
export function appearanceOf(c: Context, options: Pick<AppearanceOptions, 'cookie'> = {}): Appearance {
  const value = getCookie(c, options.cookie ?? 'appearance')
  return (APPEARANCES as readonly string[]).includes(value ?? '') ? (value as Appearance) : 'system'
}

/**
 * Light, dark or the system's theme, without a flash of the wrong one on the first paint:
 * `dark` and `light` are rendered as the `<html>` class by the server; `system` is resolved by a
 * tiny inline script (with the CSP nonce) before anything paints; and the background is set inline.
 * Pass it to `defineInertia({ document: [appearance()] })`; the page's hook writes the cookie.
 */
export function appearance(options: AppearanceOptions = {}): DocumentPart {
  const background = options.background ?? { light: '#ffffff', dark: '#161616' }
  return {
    attributes(c) {
      const value = appearanceOf(c, options)
      if (value === 'system') return {}
      return { class: value === 'dark' ? 'dark' : undefined, style: `color-scheme: ${value}` }
    },
    head(c, nonce) {
      const n = nonce ? ` nonce="${escapeAttribute(nonce)}"` : ''
      const style = `<style${n}>html{background-color:${background.light}}html.dark{background-color:${background.dark}}</style>`
      if (appearanceOf(c, options) !== 'system') return style
      const script = `<script${n}>(function(){var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var r=document.documentElement;if(d)r.classList.add('dark');r.style.colorScheme=d?'dark':'light'})()</script>`
      return `${script}\n    ${style}`
    },
  }
}
