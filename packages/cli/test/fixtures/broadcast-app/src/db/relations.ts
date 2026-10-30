import { defineRelations } from 'drizzle-orm'
import { posts, users } from './schema.js'

export const relations = defineRelations({ users, posts }, () => ({}))
