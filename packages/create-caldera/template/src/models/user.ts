import { defineModel } from '@caldera-js/db'
import { defineNotifiable } from '@caldera-js/notifications'
import { users } from '../db/schema.js'

export const User = defineModel(users, {
  name: 'user',
})

/** How notifications reach a user: `notify(user, Welcome, payload)` files them under `user:<id>`. */
export const UserNotifiable = defineNotifiable<typeof users.$inferSelect>({
  type: 'user',
  id: (user) => user.id,
  routes: { mail: (user) => ({ email: user.email, name: user.name }) },
})
