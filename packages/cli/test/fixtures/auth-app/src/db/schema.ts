import { authUserColumns } from '@caldera-js/auth'
import { snakeCase } from 'drizzle-orm/pg-core'

export const users = snakeCase.table('users', authUserColumns())
