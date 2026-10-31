/** Name variants generators fill into stubs. `blog post`, `BlogPost` and `blog-post` all give the same set. */
export interface Names {
  /** BlogPost: exported model, factory and policy names. */
  Name: string
  /** blogPost: the model's `name` (policy registry key). */
  name: string
  /** blog-post: file names. */
  kebab: string
  /** blog_posts: SQL table names. */
  table: string
  /** blogPosts: relations keys and route group names. */
  plural: string
}

export function names(input: string): Names {
  const words = input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  if (words.length === 0) throw new Error(`"${input}" isn't a usable name.`)
  const pascal = (list: string[]) => list.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')
  const camel = (list: string[]) => list[0]! + pascal(list.slice(1))
  const pluralWords = [...words.slice(0, -1), pluralize(words.at(-1)!)]
  return {
    Name: pascal(words),
    name: camel(words),
    kebab: words.join('-'),
    table: pluralWords.join('_'),
    plural: camel(pluralWords),
  }
}

/** The singular a plural came from (`notes` → `note`, `categories` → `category`); a singular is kept. */
export function singularize(word: string): string {
  for (const candidate of [word.endsWith('ies') ? `${word.slice(0, -3)}y` : '', word.endsWith('es') ? word.slice(0, -2) : '', word.endsWith('s') ? word.slice(0, -1) : '']) {
    if (candidate && pluralize(candidate) === word) return candidate
  }
  return word
}

export function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}

/** Fills `{{ Name }}`-style placeholders. Unknown placeholders are left as they are. */
export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => values[key] ?? match)
}
