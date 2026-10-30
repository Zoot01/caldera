import { customType, integer } from 'drizzle-orm/sqlite-core'
import type { z } from 'zod'
import { jsonCodec } from './json.js'

/** A JSON `text` column validated by a Zod schema on write and on read. */
export function zjson<S extends z.ZodType>(schema: S) {
  const { decode, encode } = jsonCodec(schema)
  return customType<{ data: z.output<S>; driverData: string; jsonData: unknown }>({
    dataType: () => 'text',
    toDriver: encode,
    fromDriver: decode,
    fromJson: decode,
  })()
}

/** `createdAt` and `updatedAt` as millisecond timestamps, set automatically. */
export function timestamps() {
  return {
    createdAt: integer({ mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  }
}
