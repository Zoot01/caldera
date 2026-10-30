// Runtime-only (excluded from typecheck): the type registry holds the Postgres fixture schema.
import { createClient } from '@libsql/client'
import { defineRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { snakeCase, text } from 'drizzle-orm/sqlite-core'
import { beforeEach, expect, it } from 'vitest'
import { createDatabase, defineModel, setDefaultDatabase } from '../src/index.js'
import { timestamps } from '../src/sqlite.js'

const notes = snakeCase.table('notes', {
  id: text().primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text().notNull(),
  ...timestamps(),
})
const relations = defineRelations({ notes })
const events: string[] = []
const Note: any = defineModel(notes as any, { name: 'note', hooks: { created: (row: any) => void events.push(row.title) } } as any)

let db: ReturnType<typeof createDatabase>
beforeEach(async () => {
  const client = createClient({ url: ':memory:' })
  await client.execute('create table notes (id text primary key, title text not null, created_at integer not null, updated_at integer not null)')
  db = createDatabase(drizzle({ client, relations }) as any, { driver: 'sqlite' })
  setDefaultDatabase(() => db)
  events.length = 0
})

it('runs async transactions with savepoints and after-commit hooks on libsql', async () => {
  await db.transaction(async () => {
    await Note.create({ title: 'kept' })
    await db
      .transaction(async () => {
        await Note.create({ title: 'savepoint rolled back' })
        throw new Error('inner')
      })
      .catch(() => {})
    expect(events).toEqual([])
  })
  expect(events).toEqual(['kept'])
  expect((await Note.findMany()).map((n: any) => n.title)).toEqual(['kept'])

  await db.transaction(async () => {
    await Note.create({ title: 'outer rolled back' })
    throw new Error('outer')
  }).catch(() => {})
  expect((await Note.findMany()).map((n: any) => n.title)).toEqual(['kept'])
})
