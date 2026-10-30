import { describe, expect, it } from 'vitest'
import { defineFactory, factory } from '../src/factories.js'
import { defineSeeder } from '../src/seeders.js'
import { truncateAll, useDatabase } from '../src/testing.js'
import { connectDatabase, events, Post, User } from './model-fixtures.js'

const UserFactory = defineFactory(User, {
  definition: ({ seq }) => ({ name: `User ${seq}`, email: `user${seq}@test.dev`, passwordHash: 'x' }),
})
const baseline = defineSeeder({ name: 'baseline', run: () => factory(UserFactory).with({ name: 'Seeded Admin', email: 'admin@test.dev' }).create() })

describe('useDatabase (transaction strategy)', () => {
  const db = useDatabase({ connect: async () => (await connectDatabase()).db, seed: [baseline] })

  it('starts from the seeded state and can write freely', async () => {
    expect((await User.findMany()).map((u) => u.name)).toEqual(['Seeded Admin'])
    await factory(UserFactory).count(3).create()
    expect(await User.findMany()).toHaveLength(4)
  })

  it('sees none of the previous test’s writes', async () => {
    expect((await User.findMany()).map((u) => u.name)).toEqual(['Seeded Admin'])
  })

  it('treats transactions inside a test as savepoints, with after-commit callbacks firing on their commit', async () => {
    expect(db().inTransaction()).toBe(false) // the wrapping test transaction is invisible to app code
    const author = (await User.findFirst())!
    events.length = 0
    await db().transaction(async () => {
      await Post.forceCreate({ title: 'Inner', slug: '', authorId: author.id })
      expect(events).toEqual([]) // still waiting for this transaction's commit
    })
    expect(events).toEqual(['created:inner'])

    await db()
      .transaction(async () => {
        await Post.forceCreate({ title: 'Doomed', slug: '', authorId: author.id })
        throw new Error('roll back the savepoint')
      })
      .catch(() => {})
    expect((await Post.findMany()).map((p) => p.slug)).toEqual(['inner'])
  })

  it('still rolls back the savepoint test’s rows', async () => {
    expect(await Post.findMany()).toEqual([])
  })
})

describe('useDatabase (truncate strategy)', () => {
  const db = useDatabase({ connect: async () => (await connectDatabase()).db, seed: [baseline], strategy: 'truncate' })

  it('commits for real, so other connections could see the data', async () => {
    await factory(UserFactory).create()
    expect(db().inTransaction()).toBe(false)
    expect(await User.findMany()).toHaveLength(2)
  })

  it('empties tables and reseeds between tests', async () => {
    expect((await User.findMany()).map((u) => u.name)).toEqual(['Seeded Admin'])
  })

  it('truncateAll empties every table in the relations', async () => {
    await truncateAll(db())
    expect(await User.withTrashed().findMany()).toEqual([])
  })
})
