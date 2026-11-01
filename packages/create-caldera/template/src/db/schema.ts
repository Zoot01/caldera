import { timestamps } from '@caldera-js/db/sqlite'
import { snakeCase, text } from 'drizzle-orm/sqlite-core'

export const users = snakeCase.table('users', {
  id: text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text().notNull(),
  email: text().notNull().unique(),
  ...timestamps(),
})
