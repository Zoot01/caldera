import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'

/** What one message parameter must be. */
export type ParamKind =
  | { kind: 'value' }
  | { kind: 'number' }
  | { kind: 'date' }
  | { kind: 'tag' }
  | { kind: 'select'; cases: string[]; other: boolean }

export type Signature = Record<string, ParamKind>

/** The parameters an ICU message takes. Throws (with the parser's message) on invalid syntax. */
export function signatureOf(message: string): Signature {
  const signature: Signature = {}
  const add = (name: string, next: ParamKind) => {
    const current = signature[name]
    // A plain `{name}` next to `{name, plural, ...}` is still a number; a select keeps its cases.
    if (!current || current.kind === 'value') signature[name] = next
    else if (current.kind === 'select' && next.kind === 'select') {
      signature[name] = { kind: 'select', cases: [...new Set([...current.cases, ...next.cases])], other: current.other || next.other }
    }
  }
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      switch (element.type) {
        case TYPE.argument:
          add(element.value, { kind: 'value' })
          break
        case TYPE.number:
          add(element.value, { kind: 'number' })
          break
        case TYPE.date:
        case TYPE.time:
          add(element.value, { kind: 'date' })
          break
        case TYPE.plural:
          add(element.value, { kind: 'number' })
          for (const option of Object.values(element.options)) walk(option.value)
          break
        case TYPE.select: {
          const cases = Object.keys(element.options)
          add(element.value, { kind: 'select', cases: cases.filter((c) => c !== 'other'), other: cases.includes('other') })
          for (const option of Object.values(element.options)) walk(option.value)
          break
        }
        case TYPE.tag:
          add(element.value, { kind: 'tag' })
          walk(element.children)
          break
        default:
          break
      }
    }
  }
  walk(parse(message, { ignoreTag: false }))
  return signature
}

/** The TypeScript type of a parameter, as `.caldera/register.d.ts` declares it. */
export function paramType(param: ParamKind): string {
  switch (param.kind) {
    case 'value':
      return 'string | number'
    case 'number':
      return 'number'
    case 'date':
      return 'Date | number'
    case 'tag':
      return '(chunks: string[]) => string'
    case 'select': {
      const cases = param.cases.map((c) => JSON.stringify(c))
      if (param.other) cases.push('(string & {})')
      return cases.length ? cases.join(' | ') : 'string'
    }
  }
}

/** `{ count: number; name: string | number }`, or `{}` for a message without parameters. */
export function signatureType(signature: Signature): string {
  const entries = Object.entries(signature)
  return entries.length ? `{ ${entries.map(([name, param]) => `${JSON.stringify(name)}: ${paramType(param)}`).join('; ')} }` : '{}'
}

/** How two locales' versions of a message differ in what they take: empty when they agree. */
export function compareSignatures(canonical: Signature, other: Signature): string[] {
  const problems: string[] = []
  for (const name of Object.keys(canonical)) if (!(name in other)) problems.push(`doesn't use {${name}}`)
  for (const name of Object.keys(other)) {
    if (!(name in canonical)) problems.push(`uses {${name}}, which the canonical message doesn't take`)
    else {
      const a = canonical[name]!
      const b = other[name]!
      // A plain {name} is fine wherever the canonical formats it; anything else must match.
      if (b.kind !== 'value' && a.kind !== b.kind) problems.push(`formats {${name}} as ${b.kind}, not ${a.kind}`)
      if (a.kind === 'select' && b.kind === 'select' && !a.other) {
        const extra = b.cases.filter((c) => !a.cases.includes(c))
        if (extra.length) problems.push(`selects {${name}} on ${extra.join(', ')}, which the canonical doesn't have`)
      }
    }
  }
  return problems
}

/**
 * Flattens a locale's JSON files into dotted keys: `lang/en/posts.json` `{ "count": "…" }` is
 * `posts.count`. Nested objects nest the key; anything that isn't a string or object is refused.
 */
export function flattenMessages(namespace: string, value: unknown, out: Record<string, string> = {}, path = namespace): Record<string, string> {
  if (typeof value === 'string') {
    out[path] = value
    return out
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path}: messages must be strings or objects of strings`)
  for (const [key, child] of Object.entries(value)) flattenMessages(namespace, child, out, path ? `${path}.${key}` : key)
  return out
}
