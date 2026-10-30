import { CalderaError } from '@caldera/core'
import type { z } from 'zod'

/**
 * Builds the encode/decode pair for a Zod-validated JSON column. Decoding is idempotent:
 * drivers hand back parsed objects at the top level but JSON text inside nested relational
 * results, so a value is tried as-is first and parsed from text only if that fails.
 */
export function jsonCodec<S extends z.ZodType>(schema: S) {
  const decode = (value: unknown): z.output<S> => {
    const direct = schema.safeParse(value)
    if (direct.success) return direct.data
    if (typeof value === 'string') {
      try {
        const parsed = schema.safeParse(JSON.parse(value))
        if (parsed.success) return parsed.data
      } catch {
        // Not JSON text; report the original validation error below.
      }
    }
    throw new CalderaError('invalid_column_value', `A JSON column holds data that doesn't match its schema: ${direct.error.message}`)
  }

  const encode = (value: z.output<S>): string => {
    const result = schema.safeParse(value)
    if (!result.success) {
      throw new CalderaError('invalid_column_value', `Refusing to write invalid JSON column data: ${result.error.message}`)
    }
    return JSON.stringify(result.data)
  }

  return { decode, encode }
}
