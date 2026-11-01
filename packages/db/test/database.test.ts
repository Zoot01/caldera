import { PGlite } from '@electric-sql/pglite'
import { CapabilityError, createApp, defineEnv } from '@caldera-js/core'
import { defineRelations, eq, sql } from 'drizzle-orm'
import { snakeCase, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import { createDatabase, databaseProvider, defaultDatabase, setDefaultDatabase } from '../src/index.js'
import { timestamps, zjsonb } from '../src/pg.js'

const PostMeta = z.object({ tags: z.array(z.string()), views: z.number().int().nonnegative().default(0) })

const users = snakeCase.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
})
const posts = snakeCase.table('posts', {
  id: uuid().primaryKey().defaultRandom(),
  title: text().notNull(),
  authorId: uuid().notNull().references(() => users.id),
  meta: zjsonb(PostMeta).notNull(),
  ...timestamps(),
})
const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
}))

async function setup() {
  const client = new PGlite()
  await client.exec(`
    create table users (id uuid primary key default gen_random_uuid(), name text not null);
    create table posts (
      id uuid primary key default gen_random_uuid(),
      title text not null,
      author_id uuid not null references users(id),
      meta jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `)
  const orm = drizzle({ client, relations })
  const [ann] = await orm.insert(users).values({ name: 'Ann' }).returning()
  return { orm, db: createDatabase(orm, { driver: 'postgres' }), ann: ann! }
}

let ctx: Awaited<ReturnType<typeof setup>>
beforeEach(async () => {
  ctx = await setup()
})

const count = async () => (await ctx.orm.select({ n: sql<number>`count(*)::int` }).from(posts))[0]!.n

describe('column helpers', () => {
  it('validates JSON columns on write and types them on read', async () => {
    const [post] = await ctx.orm.insert(posts).values({ title: 'Hi', authorId: ctx.ann.id, meta: { tags: ['a'], views: 0 } }).returning()
    expectTypeOf(post!.meta).toEqualTypeOf<{ tags: string[]; views: number }>()
    expect(post!.meta).toEqual({ tags: ['a'], views: 0 })

    await expect(
      ctx.orm.insert(posts).values({ title: 'Bad', authorId: ctx.ann.id, meta: { tags: 'nope' } as never }),
    ).rejects.toThrow(/invalid JSON column data/)
  })

  it('decodes JSON columns inside nested relational results', async () => {
    await ctx.orm.insert(posts).values({ title: 'Nested', authorId: ctx.ann.id, meta: { tags: ['x'], views: 3 } })
    const result = await ctx.orm.query.users.findMany({ with: { posts: true } })
    expect(result[0]!.posts[0]!.meta).toEqual({ tags: ['x'], views: 3 })
  })

  it('sets timestamps and bumps updatedAt on update', async () => {
    const [post] = await ctx.orm.insert(posts).values({ title: 'T', authorId: ctx.ann.id, meta: { tags: [], views: 0 } }).returning()
    expect(post!.createdAt).toBeInstanceOf(Date)
    await new Promise((r) => setTimeout(r, 5))
    const [updated] = await ctx.orm.update(posts).set({ title: 'T2' }).where(eq(posts.id, post!.id)).returning()
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(post!.updatedAt.getTime())
  })
})

describe('transactions', () => {
  const newPost = (title: string) => ({ title, authorId: ctx.ann.id, meta: { tags: [], views: 0 } })

  it('lets nested code join the transaction through current()', async () => {
    const insertSomewhereDeep = () => (ctx.db.current() as typeof ctx.orm).insert(posts).values(newPost('deep'))
    await expect(
      ctx.db.transaction(async () => {
        expect(ctx.db.inTransaction()).toBe(true)
        await insertSomewhereDeep()
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    expect(await count()).toBe(0)
    expect(ctx.db.inTransaction()).toBe(false)
  })

  it('runs after-commit callbacks only after a successful commit', async () => {
    const seen: string[] = []
    await ctx.db.transaction(async (tx) => {
      await tx.insert(posts).values(newPost('a'))
      await ctx.db.afterCommit(() => void seen.push('after-commit'))
      seen.push('in-transaction')
    })
    expect(seen).toEqual(['in-transaction', 'after-commit'])

    const dropped = vi.fn()
    await ctx.db.transaction(async () => {
      await ctx.db.afterCommit(dropped)
      throw new Error('nope')
    }).catch(() => {})
    expect(dropped).not.toHaveBeenCalled()
  })

  it('runs callbacks immediately outside a transaction', async () => {
    const callback = vi.fn()
    await ctx.db.afterCommit(callback)
    expect(callback).toHaveBeenCalledOnce()
  })

  it('treats nested transactions as savepoints whose callbacks wait for the outer commit', async () => {
    const order: string[] = []
    await ctx.db.transaction(async (tx) => {
      await tx.insert(posts).values(newPost('outer'))
      await ctx.db
        .transaction(async (inner) => {
          await inner.insert(posts).values(newPost('inner'))
          await ctx.db.afterCommit(() => void order.push('rolled-back savepoint'))
          throw new Error('inner fails')
        })
        .catch(() => {})
      await ctx.db.transaction(async () => {
        await ctx.db.afterCommit(() => void order.push('kept savepoint'))
      })
      order.push('outer body done')
    })
    expect(order).toEqual(['outer body done', 'kept savepoint'])
    expect((await ctx.orm.select().from(posts)).map((p) => p.title)).toEqual(['outer'])
  })

  it('refuses interactive transactions on drivers without them', async () => {
    const d1Like = createDatabase(ctx.orm, { driver: 'd1' })
    await expect(d1Like.transaction(async () => {})).rejects.toBeInstanceOf(CapabilityError)
    await expect(d1Like.transaction(async () => {})).rejects.toThrow(/doesn't support interactive transactions/)
  })
})

describe('databaseProvider', () => {
  it('connects lazily and becomes the default database', async () => {
    setDefaultDatabase(undefined)
    expect(() => defaultDatabase()).toThrow(/No database is configured/)
    const connect = vi.fn(() => ctx.orm)
    const app = createApp({ env: defineEnv({}), providers: [databaseProvider({ driver: 'postgres', connect })] })
    await app.boot({ env: {} })
    expect(connect).not.toHaveBeenCalled()

    expect(defaultDatabase().driver).toBe('postgres')
    expect(connect).toHaveBeenCalledOnce()
    expect(app.services.db.client).toBe(ctx.orm)

    await app.shutdown()
    expect(() => defaultDatabase()).toThrow(/No database is configured/)
  })
})
