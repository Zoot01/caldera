import { defineModel } from '@caldera-js/db'
import { users } from '../db/schema.js'

export const User = defineModel(users, { name: 'user' })
