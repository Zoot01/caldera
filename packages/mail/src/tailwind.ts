import { CalderaError } from '@caldera/core'
import { Children, cloneElement, createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'

/** What React Email's <Tailwind> produced for one className (string or single class). */
export interface CompiledEntry {
  /** The inline style it applies. */
  style: Record<string, string>
  /** Classes that stay on the element: media queries and states (`sm:`, `hover:`), styled by `css`. */
  keep: string[]
}

export interface CompiledTailwind {
  /** Per className string seen in the templates (exact, since classes combine through CSS variables). */
  strings: Record<string, CompiledEntry>
  /** Per single class, for className strings built at runtime. */
  classes: Record<string, CompiledEntry>
  /** The rules that can't be inlined, for the <head>. */
  css: string
}

/** Compiled styles per Tailwind config (keyed by `configKey`), written by `caldera generate`. */
export type MailStyles = Record<string, CompiledTailwind>

const STYLES = Symbol.for('caldera.mail.tailwind')
const registry = globalThis as { [STYLES]?: { styles: MailStyles; recording?: unknown[] } }
const state = () => (registry[STYLES] ??= { styles: {} })

/** Called by `.caldera/mails.gen.ts`: the styles `caldera generate` compiled from your templates. */
export function setMailStyles(styles: MailStyles) {
  state().styles = styles
}

/** For `caldera generate`: renders record the configs <Tailwind> is given, instead of styling. */
export function recordTailwindConfigs(): { configs: unknown[]; stop(): void } {
  const configs: unknown[] = []
  state().recording = configs
  return {
    configs,
    stop: () => {
      if (state().recording === configs) state().recording = undefined
    },
  }
}

/** The key a config's compiled styles are stored under (functions by their source, as React Email does). */
export function configKey(config: unknown): string {
  return JSON.stringify(config ?? {}, (_key, value) => (typeof value === 'function' ? value.toString() : value))
}

/** `padding:16px;background-color:#fff` → `{ padding: '16px', backgroundColor: '#fff' }` (custom properties kept). */
export function styleObject(css: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const declaration of css.split(/;(?![^(]*\))/)) {
    const index = declaration.indexOf(':')
    if (index < 0) continue
    const property = declaration.slice(0, index).trim()
    const value = declaration.slice(index + 1).trim()
    if (!property || !value) continue
    out[property.startsWith('--') ? property : property.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value
  }
  return out
}

const warned = new Set<string>()
const isProduction = () => (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === 'production'

/**
 * Tailwind for mail templates, without compiling Tailwind when a mail is sent: a drop-in for React
 * Email's <Tailwind> (`import { Tailwind } from '@caldera/mail/tailwind'`). `caldera generate` runs
 * React Email's own Tailwind over your templates' classes and keeps the result; this applies it.
 * Light enough for Workers, where compiling Tailwind on every send is too slow and too big.
 */
export function Tailwind({ children, config }: { children: ReactNode; config?: unknown }): ReactNode {
  const current = state()
  if (current.recording) {
    current.recording.push(config ?? {})
    return children
  }
  const compiled = current.styles[configKey(config)]
  if (!compiled) {
    const message = 'No compiled Tailwind styles for this mail’s config: run `caldera generate` (it compiles them from src/mail).'
    if (isProduction()) throw new CalderaError('mail_styles_missing', message)
    if (!warned.has(message)) (warned.add(message), console.warn(`[caldera] ${message}`))
    return children
  }
  let headStyled = false
  // Classes this already produced (React Email renames them: `hover:bg-black` → `hover_bg-black`).
  // A component passes them on to its own elements, which must keep them as they are.
  const kept = new Set(Object.values(compiled.strings).concat(Object.values(compiled.classes)).flatMap((entry) => entry.keep))
  const styleFor = (className: string) => {
    const normalized = className.trim().split(/\s+/).filter(Boolean).join(' ')
    const exact = compiled.strings[normalized]
    if (exact) return exact
    // Built at runtime: merged class by class (combinations through CSS variables may differ).
    const merged: CompiledEntry = { style: {}, keep: [] }
    for (const name of normalized.split(' ')) {
      if (kept.has(name)) {
        merged.keep.push(name)
        continue
      }
      const entry = compiled.classes[name]
      if (!entry) {
        if (!isProduction() && !warned.has(name)) (warned.add(name), console.warn(`[caldera] Tailwind class "${name}" wasn't compiled: write it in a template as a literal (className="…"), then \`caldera generate\`.`))
        continue
      }
      Object.assign(merged.style, entry.style)
      merged.keep.push(...entry.keep)
    }
    return merged
  }

  const map = (node: ReactNode): ReactNode => {
    if (Array.isArray(node)) return Children.map(node, map)
    if (!isValidElement(node)) return node
    let element = node as ReactElement<Record<string, unknown>>
    const type = element.type as unknown
    // Styled first, then expanded, as React Email does: a component (<Text>, <Button>) gets the style
    // as a prop and merges it with its own defaults.
    if (typeof element.props.className === 'string' && type !== Fragment) {
      const { style, keep } = styleFor(element.props.className)
      element = cloneElement(element, { style: { ...style, ...(element.props.style as object | undefined) }, className: keep.length ? keep.join(' ') : undefined })
    }
    // Expand components to reach the elements they render.
    if (typeof type === 'function' && !(type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
      return map((type as (props: unknown) => ReactNode)(element.props))
    }
    if (typeof type === 'object' && type !== null) {
      const wrapped = type as { render?: (props: unknown, ref: unknown) => ReactNode; type?: unknown }
      if (typeof wrapped.render === 'function') return map(wrapped.render(element.props, null))
      if (wrapped.type) return map(createElement(wrapped.type as never, element.props))
    }
    let children = element.props.children === undefined ? undefined : map(element.props.children as ReactNode)
    if (type === 'head' && compiled.css) {
      headStyled = true
      children = [createElement('style', { key: 'caldera-tailwind', dangerouslySetInnerHTML: { __html: compiled.css } }), children]
    }
    return children === undefined ? element : cloneElement(element, {}, children)
  }

  const result = map(children)
  if (compiled.css && !headStyled && !isProduction()) {
    console.warn('[caldera] This mail uses Tailwind classes that need a <head> (media queries, hover:…), but it has none: add <Head /> inside <Tailwind>.')
  }
  return result
}

/**
 * React Email's pixelBasedPreset (px instead of rem, which many mail clients mishandle), as data here so
 * importing it doesn't bring the Tailwind compiler into your bundle. Kept equal to theirs by a test.
 */
export const pixelBasedPreset = {
  "theme": {
    "extend": {
      "fontSize": {
        "xs": [
          "12px",
          {
            "lineHeight": "16px"
          }
        ],
        "sm": [
          "14px",
          {
            "lineHeight": "20px"
          }
        ],
        "base": [
          "16px",
          {
            "lineHeight": "24px"
          }
        ],
        "lg": [
          "18px",
          {
            "lineHeight": "28px"
          }
        ],
        "xl": [
          "20px",
          {
            "lineHeight": "28px"
          }
        ],
        "2xl": [
          "24px",
          {
            "lineHeight": "32px"
          }
        ],
        "3xl": [
          "30px",
          {
            "lineHeight": "36px"
          }
        ],
        "4xl": [
          "36px",
          {
            "lineHeight": "36px"
          }
        ],
        "5xl": [
          "48px",
          {
            "lineHeight": "1"
          }
        ],
        "6xl": [
          "60px",
          {
            "lineHeight": "1"
          }
        ],
        "7xl": [
          "72px",
          {
            "lineHeight": "1"
          }
        ],
        "8xl": [
          "96px",
          {
            "lineHeight": "1"
          }
        ],
        "9xl": [
          "144px",
          {
            "lineHeight": "1"
          }
        ]
      },
      "spacing": {
        "0": "0",
        "1": "4px",
        "2": "8px",
        "3": "12px",
        "4": "16px",
        "5": "20px",
        "6": "24px",
        "7": "28px",
        "8": "32px",
        "9": "36px",
        "10": "40px",
        "11": "44px",
        "12": "48px",
        "14": "56px",
        "16": "64px",
        "20": "80px",
        "24": "96px",
        "28": "112px",
        "32": "128px",
        "36": "144px",
        "40": "160px",
        "44": "176px",
        "48": "192px",
        "52": "208px",
        "56": "224px",
        "60": "240px",
        "64": "256px",
        "72": "288px",
        "80": "320px",
        "96": "384px",
        "px": "1px",
        "0.5": "2px",
        "1.5": "6px",
        "2.5": "10px",
        "3.5": "14px"
      }
    }
  }
} as const
