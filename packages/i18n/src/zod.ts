import type { Translator } from './i18n.js'

/** The issue fields Zod 4 gives an error map (`schema.safeParse(input, { error })`). */
interface IssueLike {
  code?: string
  path?: PropertyKey[]
  input?: unknown
  origin?: string
  format?: string
  expected?: string
  minimum?: number | bigint | Date
  maximum?: number | bigint | Date
  inclusive?: boolean
  exact?: boolean
  divisor?: number
  keys?: string[]
  values?: unknown[]
}

/**
 * A Zod error map that writes validation messages in the translator's locale. Keys, first match wins:
 * 1. `validation.custom.<path>.<code>.<variant>`, then `validation.custom.<path>.<code>` (one field)
 * 2. `validation.<code>.<variant>`, then `validation.<code>`
 *
 * The variant is the origin for size rules (`too_small.string`, `too_big.array`; `.exact` appended
 * for exact lengths), the format for `invalid_format` (`.email`), and `required` for a missing
 * value. Array indices in paths are `*`: `items.*.name`. `{attribute}` is `validation.attributes.<path>`,
 * or the field name in words. Messages written in a schema (`z.string().min(3, '…')`) win over all
 * of these; with no key at all, Zod's own English message is kept.
 */
export function zodErrorMap(translator: Translator): (issue: IssueLike) => string | undefined {
  return (issue) => {
    const code = issue.code
    if (!code) return undefined
    const path = (issue.path ?? []).map((p) => (typeof p === 'number' ? '*' : String(p))).join('.')
    const variant = variantOf(issue)
    const candidates = [
      ...(path ? [...(variant ? [`validation.custom.${path}.${code}.${variant}`] : []), `validation.custom.${path}.${code}`] : []),
      ...(variant ? [`validation.${code}.${variant}`] : []),
      `validation.${code}`,
    ]
    const key = candidates.find((k) => translator.has(k))
    if (!key) return undefined
    const t = translator.t as (key: string, params?: Record<string, unknown>) => string
    const attributeKey = `validation.attributes.${path}`
    const attribute = path && translator.has(attributeKey) ? t(attributeKey) : humanize(issue.path)
    const bound = (value: unknown) =>
      issue.origin === 'date' || value instanceof Date ? translator.date(new Date(value instanceof Date ? value : Number(value)), { dateStyle: 'medium' }) : typeof value === 'bigint' ? Number(value) : value
    return t(key, {
      attribute,
      ...(issue.minimum !== undefined ? { minimum: bound(issue.minimum) } : {}),
      ...(issue.maximum !== undefined ? { maximum: bound(issue.maximum) } : {}),
      // `{inclusive, select, true {at least} other {more than}}`: gt/lt rules aren't inclusive.
      ...(code === 'too_small' || code === 'too_big' ? { inclusive: issue.inclusive === false ? 'false' : 'true' } : {}),
      ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
      ...(issue.format !== undefined ? { format: issue.format } : {}),
      ...(issue.divisor !== undefined ? { divisor: issue.divisor } : {}),
      ...(issue.keys ? { keys: translator.list(issue.keys) } : {}),
      ...(issue.values ? { values: translator.list(issue.values.map(String), { type: 'disjunction' }) } : {}),
    })
  }
}

function variantOf(issue: IssueLike): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined || issue.input === null || issue.input === '' ? 'required' : undefined
    case 'too_small':
    case 'too_big':
      // int and number read the same to people.
      return issue.origin ? `${issue.origin === 'int' ? 'number' : issue.origin}${issue.exact ? '.exact' : ''}` : undefined
    case 'invalid_format':
      return issue.format
    default:
      return undefined
  }
}

/** `firstName` / `first_name` / `items.0.unit_price` → `first name` / `unit price`. */
function humanize(path: PropertyKey[] | undefined): string {
  const last = [...(path ?? [])].reverse().find((p) => typeof p === 'string') as string | undefined
  if (!last) return 'this field'
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
}
