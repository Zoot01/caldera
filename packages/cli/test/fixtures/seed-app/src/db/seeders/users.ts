import { defineSeeder } from '@caldera-js/db/seeders'
import { factory } from '@caldera-js/db/factories'
import { User } from '../../models/user.js'
import { UserFactory } from '../factories/user.js'
import { schemaSeeder } from './schema.js'

export const usersSeeder = defineSeeder({
  name: 'users',
  dependsOn: [schemaSeeder],
  run: async ({ log }) => {
    await factory(UserFactory).count(3).create()
    const names = (await User.findMany()).map((u) => u.name)
    log(`users: ${names.join(' | ')}`)
  },
})

export const demoSeeder = defineSeeder({ name: 'demo', environments: ['local'], run: ({ log }) => log('demo data') })
