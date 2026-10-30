import { defineRelations } from 'drizzle-orm'
import { users } from './schema.js'

export const relations = defineRelations({ users })
