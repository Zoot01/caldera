import { authUserColumns } from '@caldera/auth'
import { snakeCase } from 'drizzle-orm/pg-core'

export const users = snakeCase.table('users', authUserColumns())
