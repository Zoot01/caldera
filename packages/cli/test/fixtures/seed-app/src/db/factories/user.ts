import { defineFactory } from '@caldera/db/factories'
import { User } from '../../models/user.js'

export const UserFactory = defineFactory(User, {
  definition: ({ faker, seq }) => ({ name: faker.person.fullName(), email: `user${seq}@seed.test` }),
})
