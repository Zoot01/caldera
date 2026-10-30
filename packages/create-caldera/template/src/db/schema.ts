import { timestamps } from '@caldera/db/sqlite'
import { snakeCase, text } from 'drizzle-orm/sqlite-core'

export const users = snakeCase.table('users', {
  id: text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text().notNull(),
  email: text().notNull().unique(),
  ...timestamps(),
})
