// Tints for avatars without a picture: a pale fill, a slightly stronger border, and the letter in
// the colour. Written out in full so Tailwind finds every class.
const COLORS = [
  'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  'border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-300',
  'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  'border-teal-500/25 bg-teal-500/10 text-teal-700 dark:text-teal-300',
  'border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  'border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
] as const

/** The avatar colour classes for a name: picked by the name, so it's always the same one for it. */
export function avatarColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return COLORS[hash % COLORS.length]!
}
