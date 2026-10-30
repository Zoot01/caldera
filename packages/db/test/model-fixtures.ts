import { PGlite } from '@electric-sql/pglite'
import { defineRelations } from 'drizzle-orm'
import { snakeCase, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { z } from 'zod'
import { createDatabase, defineModel, setDefaultDatabase } from '../src/index.js'
import { timestamps, zjsonb } from '../src/pg.js'

export const users = snakeCase.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  role: text().notNull().default('member'),
  deletedAt: timestamp({ withTimezone: true }),
})

export const posts = snakeCase.table('posts', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  title: text().notNull(),
  body: text().notNull().default(''),
  internalNotes: text(),
  authorId: uuid()
    .notNull()
    .references(() => users.id),
  meta: zjsonb(z.object({ tags: z.array(z.string()) })),
  publishedAt: timestamp({ withTimezone: true }),
  deletedAt: timestamp({ withTimezone: true }),
  ...timestamps(),
})

export const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
}))

export const events: string[] = []

export const User = defineModel(users, {
  name: 'user',
  hidden: ['passwordHash'],
  guarded: ['role'],
  softDeletes: 'deletedAt',
  appends: { initials: (u) => u.name.split(' ').map((part) => part[0]).join('') },
})

const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export const Post = defineModel(posts, {
  name: 'post',
  hidden: ['internalNotes'],
  guarded: ['authorId'],
  softDeletes: 'deletedAt',
  routeKey: 'slug',
  scopes: {
    published: () => ({ publishedAt: { isNotNull: true } }),
    titled: (title: string) => ({ title }),
  },
  appends: { excerpt: (p) => p.body.slice(0, 5) },
  hooks: {
    creating: (values) => ({ ...values, slug: values.slug || slugify(values.title) }),
    created: (row) => void events.push(`created:${row.slug}`),
    updating: ({ patch }) => ({ ...patch, title: patch.title?.trim() }),
    updated: ({ before, after }) => void events.push(`updated:${before.title}->${after.title}`),
    deleted: (row) => void events.push(`deleted:${row.slug}`),
  },
})

// What `caldera generate` will write for a real app.
declare module '../src/model/registry.js' {
  interface DatabaseRegister {
    relations: typeof relations
  }
  interface ModelRegistry {
    users: typeof User
    posts: typeof Post
  }
}

export const SCHEMA_SQL = `
  create table users (
    id uuid primary key default gen_random_uuid(),
    name text not null, email text not null unique, password_hash text not null,
    role text not null default 'member', deleted_at timestamptz
  );
  create table posts (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique, title text not null, body text not null default '', internal_notes text,
    author_id uuid not null references users(id), meta jsonb, published_at timestamptz, deleted_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
`

/** A fresh in-memory Postgres with the fixture schema, not yet the default database. */
export async function connectDatabase() {
  const client = new PGlite()
  await client.exec(SCHEMA_SQL)
  const orm = drizzle({ client, relations })
  return { orm, db: createDatabase(orm, { driver: 'postgres' }) }
}

export async function setupDatabase() {
  const { orm, db } = await connectDatabase()
  setDefaultDatabase(() => db)
  events.length = 0
  return { orm, db }
}
