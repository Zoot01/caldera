import { render } from '@react-email/render'
import { createElement } from 'react'
import { styleObject, type CompiledTailwind } from './tailwind.js'

/**
 * Runs React Email's own <Tailwind> once per className string (and per single class, for class
 * names built at runtime), at build time, and keeps what it produced: the inline styles, the
 * classes that must stay (media queries, hover:…) and the <head> CSS for them. Whole strings, not
 * just single classes, because Tailwind classes combine through CSS variables (`ring-2 ring-blue-500`).
 * Node only: it needs @react-email/tailwind (the Tailwind compiler), which the runtime never loads.
 */
export async function compileTailwind(config: unknown, classNames: readonly string[]): Promise<CompiledTailwind> {
  const { Tailwind } = (await import('@react-email/tailwind')) as unknown as { Tailwind: (props: { config?: unknown; children: unknown }) => unknown }
  const normalized = [...new Set(classNames.map(normalize).filter(Boolean))]
  const singles = [...new Set(normalized.flatMap((c) => c.split(' ')))]
  const all = [...normalized, ...singles.filter((c) => !normalized.includes(c))]
  const tree = createElement(
    Tailwind as never,
    { config } as never,
    createElement('html', null, createElement('head', null), createElement('body', null, ...all.map((className, i) => createElement('div', { key: i, 'data-caldera-i': String(i), className })))),
  )
  const html = await render(tree as never)
  const compiled: CompiledTailwind = { strings: {}, classes: {}, css: /<head>[\s\S]*?<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '' }
  for (const match of html.matchAll(/<div ([^>]*?)data-caldera-i="(\d+)"([^>]*)>/g)) {
    const attributes = `${match[1]} ${match[3]}`
    const className = all[Number(match[2])]!
    const style = /style="([^"]*)"/.exec(attributes)?.[1] ?? ''
    const kept = /class="([^"]*)"/.exec(attributes)?.[1] ?? ''
    const entry = { style: styleObject(decode(style)), keep: kept ? kept.split(/\s+/) : [] }
    if (normalized.includes(className)) compiled.strings[className] = entry
    if (singles.includes(className)) compiled.classes[className] = entry
  }
  return compiled
}

/**
 * The className strings in a mail template's source (and its shared components): `className="…"`,
 * `className={'…'}`, `className={`…`}` without interpolation, and string literals inside `clsx(…)`/`cn(…)`
 * calls. Dynamic parts are out of reach here, as they are for Tailwind's own scanner.
 */
export function classNamesIn(source: string): string[] {
  const found: string[] = []
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{\s*'([^']*)'\s*\}|\{\s*"([^"]*)"\s*\}|\{\s*`([^`$]*)`\s*\})/g)) found.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')
  for (const call of source.matchAll(/\b(?:clsx|cn|classNames)\(([^)]*)\)/g)) for (const s of call[1]!.matchAll(/'([^']*)'|"([^"]*)"/g)) found.push(s[1] ?? s[2] ?? '')
  return found.map(normalize).filter(Boolean)
}

const normalize = (className: string) => className.trim().split(/\s+/).filter(Boolean).join(' ')

function decode(text: string) {
  return text.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}
