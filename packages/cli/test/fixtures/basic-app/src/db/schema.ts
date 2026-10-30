import { snakeCase, text, uuid } from 'drizzle-orm/pg-core'

export const users = snakeCase.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  passwordHash: text().notNull(),
})

export const posts = snakeCase.table('posts', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull(),
  title: text().notNull(),
  authorId: uuid().notNull(),
})
