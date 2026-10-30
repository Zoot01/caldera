import { CalderaError } from './errors.js'

/** A duration as config and APIs accept it: seconds, or `'90s'`, `'30m'`, `'2h'`, `'7d'`. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

const UNITS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 } as const

/** Seconds in a duration. `'500ms'` gives 0.5. */
export function parseDuration(value: Duration | string): number {
  if (typeof value === 'number') return value
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim())
  if (!match) throw new CalderaError('invalid_duration', `Can't read "${value}" as a duration; use e.g. '30m', '2h' or '7d'.`)
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
}
