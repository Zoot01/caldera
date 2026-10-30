import { defineModel } from '@caldera/db'
import { users } from '../db/schema.js'

export const User = defineModel(users, {
  name: 'user',
})
