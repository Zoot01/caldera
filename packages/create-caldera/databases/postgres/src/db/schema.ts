import { timestamps } from '@caldera-js/db/pg'
import { snakeCase, text, uuid } from 'drizzle-orm/pg-core'

export const users = snakeCase.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text().notNull().unique(),
  ...timestamps(),
})
