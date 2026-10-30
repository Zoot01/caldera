import { customType, timestamp } from 'drizzle-orm/pg-core'
import type { z } from 'zod'
import { jsonCodec } from './json.js'

/** A `jsonb` column validated by a Zod schema on write and on read. Its type is the schema's output. */
export function zjsonb<S extends z.ZodType>(schema: S) {
  const { decode, encode } = jsonCodec(schema)
  return customType<{ data: z.output<S>; driverData: string; jsonData: unknown }>({
    dataType: () => 'jsonb',
    toDriver: encode,
    fromDriver: decode,
    fromJson: decode,
  })()
}

/** `createdAt` and `updatedAt`, both set automatically, also for raw Drizzle writes. */
export function timestamps() {
  return {
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  }
}
