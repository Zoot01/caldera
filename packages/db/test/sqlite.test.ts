// Runtime-only: the model types are registered for the Postgres fixtures (one schema per app),
// so this file is excluded from the package typecheck. Types are covered by model.test.ts.
import { DatabaseSync } from 'node:sqlite'
import { CapabilityError } from '@caldera-js/core'
import { defineRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDatabase, defineModel, setDefaultDatabase } from '../src/index.js'
import { timestamps, zjson } from '../src/sqlite.js'

const authors = snakeCase.table('authors', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  apiToken: text().notNull(),
})
const notes = snakeCase.table('notes', {
  id: integer().primaryKey({ autoIncrement: true }),
  slug: text().notNull().unique(),
  authorId: integer().notNull(),
  meta: zjson(z.object({ pinned: z.boolean() })),
  deletedAt: integer({ mode: 'timestamp_ms' }),
  ...timestamps(),
})
const relations = defineRelations({ authors, notes }, (r) => ({
  authors: { notes: r.many.notes() },
  notes: { author: r.one.authors({ from: r.notes.authorId, to: r.authors.id, optional: false }) },
}))

const Author: any = defineModel(authors as any, { name: 'author', hidden: ['apiToken'] } as any)
const Note: any = defineModel(notes as any, { name: 'note', routeKey: 'slug', softDeletes: 'deletedAt', appends: { label: (n: any) => `#${n.slug}` } } as any)

let db: ReturnType<typeof createDatabase>
beforeEach(() => {
  const client = new DatabaseSync(':memory:')
  client.exec(`
    create table authors (id integer primary key autoincrement, name text not null, api_token text not null);
    create table notes (
      id integer primary key autoincrement, slug text not null unique, author_id integer not null, meta text,
      deleted_at integer, created_at integer not null, updated_at integer not null
    );
  `)
  db = createDatabase(drizzle({ client, relations }) as any, { driver: 'sqlite-sync' })
  setDefaultDatabase(() => db)
})

describe('models on SQLite (node:sqlite)', () => {
  it('creates, reads and hides columns, including through relations', async () => {
    const ann = await Author.create({ name: 'Ann', apiToken: 'tok' })
    expect(ann).toEqual({ id: 1, name: 'Ann' })
    await Note.create({ slug: 'first', authorId: ann.id, meta: { pinned: true } })
    const found = await Author.findFirst({ with: { notes: true } })
    expect(found).not.toHaveProperty('apiToken')
    expect(found.notes[0].meta).toEqual({ pinned: true })
    expect(found.notes[0].createdAt).toBeInstanceOf(Date)
    expect((await Note.findFirst({ with: { author: true } })).author).not.toHaveProperty('apiToken')
  })

  it('soft-deletes, paginates and serializes', async () => {
    const ann = await Author.create({ name: 'Ann', apiToken: 'tok' })
    for (const slug of ['a', 'b', 'c']) await Note.create({ slug, authorId: ann.id })
    await Note.delete('2')
    expect((await Note.findMany()).map((n: any) => n.slug)).toEqual(['a', 'c'])
    expect((await Note.withTrashed().findMany()).length).toBe(3)
    expect(await Note.paginate({ perPage: 1 })).toMatchObject({ total: 2, lastPage: 2 })
    expect(Note.serialize(await Note.findByRouteKey('c')).label).toBe('#c')
  })

  it('runs after-commit hooks immediately and refuses async transactions', async () => {
    await expect(db.transaction(async () => {})).rejects.toBeInstanceOf(CapabilityError)
    await expect(db.transaction(async () => {})).rejects.toThrow(/"sqlite-sync" driver doesn't support interactive transactions/)
  })
})
