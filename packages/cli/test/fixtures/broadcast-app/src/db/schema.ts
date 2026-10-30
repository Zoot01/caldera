import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() })
export const posts = sqliteTable('posts', { id: integer('id').primaryKey(), title: text('title').notNull(), authorId: integer('author_id').notNull() })
