import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ModelNotFoundError, type Insert, type Row, type Serialized } from '../src/index.js'
import { events, Post, posts, setupDatabase, User } from './model-fixtures.js'

let ctx: Awaited<ReturnType<typeof setupDatabase>>

async function seed() {
  const ann = await User.forceCreate({ name: 'Ann Lee', email: 'ann@example.test', passwordHash: 'secret-hash', role: 'admin' })
  const post = await Post.forceCreate({ title: 'Hello World', slug: '', body: 'Lorem ipsum', authorId: ann.id, internalNotes: 'todo', publishedAt: new Date() })
  const draft = await Post.forceCreate({ title: 'Draft', slug: '', authorId: ann.id })
  return { ann, post, draft }
}

beforeEach(async () => {
  ctx = await setupDatabase()
})

describe('types', () => {
  it('removes hidden and guarded columns from row and insert types', () => {
    expectTypeOf<Row<typeof User>>().not.toHaveProperty('passwordHash')
    expectTypeOf<Row<typeof User>>().toHaveProperty('email')
    expectTypeOf<Insert<typeof User>>().not.toHaveProperty('role')
    expectTypeOf<Insert<typeof Post>>().not.toHaveProperty('authorId')
    expectTypeOf<Serialized<typeof Post>>().toHaveProperty('excerpt').toEqualTypeOf<string>()
    expectTypeOf<Row<typeof Post>['meta']>().toEqualTypeOf<{ tags: string[] } | null>()
  })

  it('drops hidden columns inside nested relation results', async () => {
    const { ann } = await seed()
    const [first] = await Post.findMany({ with: { author: true } })
    expectTypeOf(first!.author.email).toEqualTypeOf<string>()
    // @ts-expect-error hidden on the related model too
    void first!.author.passwordHash
    const [user] = await User.findMany({ where: { id: ann.id }, with: { posts: true } })
    // @ts-expect-error hidden column of a nested `many` relation
    void user!.posts[0]!.internalNotes
  })
})

describe('reads', () => {
  it('never returns hidden columns unless asked', async () => {
    const { ann } = await seed()
    expect(ann).not.toHaveProperty('passwordHash')
    const found = await User.find(ann.id)
    expect(found).not.toHaveProperty('passwordHash')
    const nested = await Post.findFirst({ with: { author: true } })
    expect(nested!.author).not.toHaveProperty('passwordHash')
    expect(nested).not.toHaveProperty('internalNotes')
    expect((await User.withHidden().find(ann.id)) as Record<string, unknown>).toMatchObject({ passwordHash: 'secret-hash' })
  })

  it('finds by route key and fails with a not_found error', async () => {
    const { post } = await seed()
    expect(post.slug).toBe('hello-world')
    expect((await Post.findByRouteKey('hello-world'))?.id).toBe(post.id)
    const error = await Post.findOrFail('00000000-0000-0000-0000-000000000000').catch((e) => e)
    expect(error).toBeInstanceOf(ModelNotFoundError)
    expect(error.code).toBe('not_found')
  })

  it('applies scopes, combined with the caller’s filters', async () => {
    await seed()
    expect((await Post.published().findMany()).map((p) => p.title)).toEqual(['Hello World'])
    expect(await Post.titled('Draft').findMany({ where: { body: 'nope' } })).toEqual([])
  })

  it('paginates with a total that respects filters and soft deletes', async () => {
    const { ann } = await seed()
    for (let i = 0; i < 4; i++) await Post.forceCreate({ title: `Post ${i}`, slug: '', authorId: ann.id })
    await Post.delete((await Post.findFirst({ where: { title: 'Post 0' } }))!)
    const page = await Post.paginate({ page: 2, perPage: 2, orderBy: { title: 'asc' } })
    expect(page).toMatchObject({ total: 5, page: 2, perPage: 2, lastPage: 3 })
    expect(page.data.map((p) => p.title)).toEqual(['Post 1', 'Post 2'])
    expect((await Post.published().paginate({ perPage: 10 })).total).toBe(1)
    // A filter on a related row takes the fallback count path.
    expect((await Post.paginate({ where: { author: { name: 'Ann Lee' } } })).total).toBe(5)
  })
})

describe('writes', () => {
  it('strips guarded columns from create, but not from forceCreate', async () => {
    const created = await User.create({ name: 'Bo', email: 'bo@example.test', passwordHash: 'x', ...({ role: 'admin' } as object) })
    expect(created.role).toBe('member')
    // @ts-expect-error role is guarded
    void (() => User.create({ name: 'C', email: 'c@example.test', passwordHash: 'x', role: 'admin' }))
  })

  it('runs -ing hooks before the write and -ed hooks after commit only', async () => {
    const { ann } = await seed()
    expect(events).toEqual(['created:hello-world', 'created:draft'])
    events.length = 0

    await ctx.db.transaction(async () => {
      await Post.forceCreate({ title: 'In Tx', slug: '', authorId: ann.id })
      expect(events).toEqual([]) // not yet committed
    })
    expect(events).toEqual(['created:in-tx'])

    events.length = 0
    await ctx.db
      .transaction(async () => {
        await Post.forceCreate({ title: 'Rolled Back', slug: '', authorId: ann.id })
        throw new Error('abort')
      })
      .catch(() => {})
    expect(events).toEqual([])
    expect(await Post.findByRouteKey('rolled-back')).toBeUndefined()
  })

  it('gives update hooks the row before and after, without an extra lookup when passed the row', async () => {
    const { post } = await seed()
    events.length = 0
    const updated = await Post.update(post, { title: '  Renamed  ' })
    expect(updated.title).toBe('Renamed')
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(post.updatedAt.getTime())
    expect(events).toEqual(['updated:Hello World->Renamed'])
    await expect(Post.update('00000000-0000-0000-0000-000000000000', { title: 'x' })).rejects.toBeInstanceOf(ModelNotFoundError)
  })
})

describe('soft deletes', () => {
  it('hides deleted rows by default and can include, isolate and restore them', async () => {
    const { post } = await seed()
    await Post.delete(post)
    expect(events).toContain('deleted:hello-world')
    expect(await Post.find(post.id)).toBeUndefined()
    expect((await Post.withTrashed().find(post.id))?.deletedAt).toBeInstanceOf(Date)
    expect((await Post.onlyTrashed().findMany()).map((p) => p.id)).toEqual([post.id])
    expect((await ctx.orm.select().from(posts)).length).toBe(2) // still in the table

    await Post.restore(post.id)
    expect(await Post.find(post.id)).toBeDefined()
    await Post.forceDelete(post.id)
    expect((await ctx.orm.select().from(posts)).length).toBe(1)
  })

  it('filters nested many relations but keeps soft-deleted one relations', async () => {
    const { ann, post, draft } = await seed()
    await Post.delete(draft)
    const user = await User.findFirst({ where: { id: ann.id }, with: { posts: true } })
    expect(user!.posts.map((p) => p.id)).toEqual([post.id])

    await User.delete(ann)
    expect(await User.find(ann.id)).toBeUndefined()
    const withAuthor = await Post.findFirst({ where: { id: post.id }, with: { author: true } })
    expect(withAuthor!.author.name).toBe('Ann Lee') // decided: `one` relations aren't filtered
    expectTypeOf(withAuthor!.author).not.toBeNullable()
  })
})

describe('serialize and using()', () => {
  it('adds appends at every level of loaded relations', async () => {
    const { ann } = await seed()
    const user = await User.findFirst({ where: { id: ann.id }, with: { posts: { orderBy: { title: 'desc' } } } })
    const json = User.serialize(user)
    expect(json!.initials).toBe('AL')
    expect(json!.posts.map((p) => p.excerpt)).toEqual(['Lorem', ''])
    expectTypeOf(json!.posts[0]!.excerpt).toEqualTypeOf<string>()
  })

  it('can target a specific database explicitly', async () => {
    const other = await setupDatabase()
    const bound = User.using(other.db)
    await bound.forceCreate({ name: 'Elsewhere', email: 'e@example.test', passwordHash: 'x' })
    expect(await bound.findMany()).toHaveLength(1)
    expect(await User.using(ctx.db).findMany()).toHaveLength(0)
  })
})
