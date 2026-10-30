import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { defineFactory, factory, factorySeed, setFactorySeed } from '../src/factories.js'
import type { Row } from '../src/index.js'
import { defineSeeder, runSeeders, sortSeeders } from '../src/seeders.js'
import { events, Post, posts, setupDatabase, User, users } from './model-fixtures.js'

const UserFactory = defineFactory(User, {
  definition: ({ faker, seq }) => ({ name: faker.person.fullName(), email: `user${seq}@test.dev`, passwordHash: 'hash' }),
  states: { admin: () => ({ role: 'admin' }) },
})

const PostFactory = defineFactory(Post, {
  definition: ({ faker, seq }) => ({ title: `Post ${seq}`, slug: '', body: faker.lorem.sentence() }),
  states: { published: () => ({ publishedAt: new Date() }) },
})

let ctx: Awaited<ReturnType<typeof setupDatabase>>
const countRows = async () => ({ users: (await ctx.orm.select().from(users)).length, posts: (await ctx.orm.select().from(posts)).length })

beforeEach(async () => {
  ctx = await setupDatabase()
  setFactorySeed(1234)
})

describe('factories', () => {
  it('creates typed rows through the model, so hooks run and hidden columns stay hidden', async () => {
    const user = await factory(UserFactory).create()
    expectTypeOf(user).toEqualTypeOf<Row<typeof User>>()
    expect(user).toMatchObject({ email: 'user1@test.dev', role: 'member' })
    expect(user).not.toHaveProperty('passwordHash')

    const post = await factory(PostFactory).for('author', user).create()
    expect(post.slug).toBe('post-1') // the model's `creating` hook built the slug
    expect(events).toContain('created:post-1')
  })

  it('applies states, counts and sequences; states may set guarded columns', async () => {
    const admins = await factory(UserFactory).admin().count(3).create()
    expectTypeOf(admins).toEqualTypeOf<Row<typeof User>[]>()
    expect(admins.map((u) => u.role)).toEqual(['admin', 'admin', 'admin'])
    expect(new Set(admins.map((u) => u.email)).size).toBe(3)

    const author = admins[0]!
    const rows = await factory(PostFactory).for('author', author).sequence({ body: 'A' }, { body: 'B' }).count(3).create()
    expect(rows.map((p) => p.body)).toEqual(['A', 'B', 'A'])
  })

  it('creates one parent for all rows with for(), and children per row with has()', async () => {
    const created = await factory(PostFactory).for('author', factory(UserFactory)).count(2).create()
    expect(new Set(created.map((p) => p.authorId)).size).toBe(1)

    const user = await factory(UserFactory).has('posts', factory(PostFactory).published().count(2)).create()
    expectTypeOf(user.posts).toEqualTypeOf<Row<typeof Post>[]>()
    expect(user.posts).toHaveLength(2)
    expect(user.posts.every((p) => p.authorId === user.id && p.publishedAt instanceof Date)).toBe(true)
    expect(await countRows()).toEqual({ users: 2, posts: 4 })
  })

  it('reuses existing parents with recycle()', async () => {
    const existing = await factory(UserFactory).create()
    const rows = await factory(PostFactory).for('author', factory(UserFactory)).recycle(User, [existing]).count(3).create()
    expect(rows.every((p) => p.authorId === existing.id)).toBe(true)
    expect((await countRows()).users).toBe(1)
  })

  it('never touches the database for raw() and make(), not even for parents', async () => {
    const raw = await factory(UserFactory).count(2).raw()
    expect(raw[0]).not.toHaveProperty('id')
    const made = await factory(PostFactory).for('author', factory(UserFactory)).make()
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(made.authorId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await countRows()).toEqual({ users: 0, posts: 0 })
  })

  it('rolls back the whole graph when any row fails', async () => {
    const author = await factory(UserFactory).create()
    const duplicateSlugs = factory(PostFactory).for('author', author).with({ slug: 'same' }).count(2)
    await expect(factory(UserFactory).has('posts', duplicateSlugs).create()).rejects.toThrow()
    expect(await countRows()).toEqual({ users: 1, posts: 0 })
  })

  it('is reproducible from a seed', async () => {
    setFactorySeed(42)
    const first = await factory(UserFactory).count(2).raw()
    setFactorySeed(42)
    const second = await factory(UserFactory).count(2).raw()
    expect(second).toEqual(first)
    expect(factorySeed()).toBe(42)
  })

  it('explains relation misuse', async () => {
    await expect(factory(UserFactory).for('posts', {}).create()).rejects.toThrow(/needs a belongs-to relation/)
    await expect(factory(PostFactory).has('author', factory(UserFactory)).create()).rejects.toThrow(/needs a has-many relation/)
    // @ts-expect-error not a relation of User
    void factory(UserFactory).has('comments', factory(PostFactory))
  })
})

describe('seeders', () => {
  const ran: string[] = []
  const usersSeeder = defineSeeder({
    name: 'users',
    run: async ({ log }) => {
      await factory(UserFactory).count(2).create()
      ran.push('users')
      log('created 2 users')
    },
  })
  const postsSeeder = defineSeeder({
    name: 'posts',
    dependsOn: [usersSeeder],
    run: async () => {
      await factory(PostFactory).for('author', factory(UserFactory)).recycle(User, await User.findMany()).count(3).create()
      ran.push('posts')
    },
  })
  const demoSeeder = defineSeeder({ name: 'demo', environments: ['local'], run: () => void ran.push('demo') })
  const referenceData = defineSeeder({ name: 'reference', production: true, run: () => void ran.push('reference') })

  beforeEach(() => {
    ran.length = 0
  })

  it('runs dependencies first, once each, and reports what happened', async () => {
    const report = await runSeeders([postsSeeder, usersSeeder, demoSeeder], { environment: 'test', seed: 7 })
    expect(ran).toEqual(['users', 'posts'])
    expect(report).toMatchObject({ schemaVersion: 1, seed: 7, environment: 'test' })
    expect(report.seeders.map((s) => [s.name, s.status])).toEqual([
      ['users', 'ran'],
      ['posts', 'ran'],
      ['demo', 'skipped'],
    ])
    expect(report.seeders[0]!.logs).toEqual(['created 2 users'])
    expect(await countRows()).toEqual({ users: 2, posts: 3 })
  })

  it('guards production: needs --force, then runs only seeders marked production', async () => {
    await expect(runSeeders([referenceData], { environment: 'production' })).rejects.toThrow(/Pass --force/)
    const report = await runSeeders([usersSeeder, referenceData], { environment: 'production', force: true })
    expect(ran).toEqual(['reference'])
    expect(report.seeders.find((s) => s.name === 'users')).toMatchObject({ status: 'skipped', reason: 'not marked production: true' })
  })

  it('rolls everything back when a seeder fails', async () => {
    const broken = defineSeeder({ name: 'broken', dependsOn: [usersSeeder], run: () => Promise.reject(new Error('boom')) })
    await expect(runSeeders([broken], { environment: 'test' })).rejects.toThrow('boom')
    expect(await countRows()).toEqual({ users: 0, posts: 0 })
  })

  it('runs a subset with only, and rejects cycles and unknown names', async () => {
    await runSeeders([usersSeeder, postsSeeder, demoSeeder], { environment: 'local', only: ['demo'] })
    expect(ran).toEqual(['demo'])
    await expect(runSeeders([usersSeeder], { environment: 'test', only: ['nope'] })).rejects.toThrow(/Unknown seeder/)

    const a = defineSeeder({ name: 'a', run: () => {} })
    const b = defineSeeder({ name: 'b', dependsOn: [a], run: () => {} })
    ;(a.dependsOn as unknown[]).push(b)
    expect(() => sortSeeders([a])).toThrow(/cycle: a → b → a/)
  })
})
