import { PGlite } from '@electric-sql/pglite'
import { createDatabase, defineModel, setDefaultDatabase, type Row } from '@caldera-js/db'
import { defineRelations } from 'drizzle-orm'
import { boolean, snakeCase, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { allow, authTables, authUserColumns, defineAbility, definePolicy, deny, denyAsNotFound } from '../src/index.js'

export const users = snakeCase.table('users', {
  ...authUserColumns(),
  isAdmin: boolean().notNull().default(false),
  plan: text().notNull().default('free'),
})
export const { session, account, verification } = authTables(users)
export const posts = snakeCase.table('posts', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  authorId: uuid().notNull(),
  published: boolean().notNull().default(false),
  secret: boolean().notNull().default(false),
})
export const relations = defineRelations({ users, posts, session, account, verification }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
}))

export const User = defineModel(users, { name: 'user' })
export const Post = defineModel(posts, { name: 'post', routeKey: 'slug' })

export const calls = { update: 0, prefetch: 0 }

export const PostPolicy = definePolicy(Post, {
  before: (user) => (user?.isAdmin ? true : undefined),
  viewAny: { guest: true, check: () => true },
  view: { guest: true, check: (user, post) => post.published || post.authorId === user?.id || denyAsNotFound() },
  create: (user) => user.plan !== 'free' || deny('Upgrade to publish.'),
  update: (user, post, g) => {
    calls.update++
    return post.authorId === user.id || g.memo('editor', () => false)
  },
  delete: (user, post) => (post.authorId === user.id ? allow() : denyAsNotFound()),
  prefetch: () => void calls.prefetch++,
  scope: { guest: true, where: (user) => (user ? { OR: [{ published: true }, { authorId: user.id }] } : { published: true }) },
})

export const viewBilling = defineAbility('viewBilling', (user) => user.plan === 'pro')
export const viewStatus = defineAbility('viewStatus', { guest: true, check: () => true })

declare module '@caldera-js/db' {
  interface DatabaseRegister {
    relations: typeof relations
  }
  interface ModelRegistry {
    users: typeof User
    posts: typeof Post
  }
}
declare module '../src/policy.js' {
  interface AuthRegister {
    user: Row<typeof User>
  }
  interface PolicyRegistry {
    post: typeof PostPolicy
  }
}

export const SCHEMA_SQL = `
  create table users (id uuid primary key default gen_random_uuid(), name text not null, email text not null unique,
    email_verified boolean not null default false, image text, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), is_admin boolean not null default false, plan text not null default 'free');
  create table posts (id uuid primary key default gen_random_uuid(), slug text not null unique, author_id uuid not null,
    published boolean not null default false, secret boolean not null default false);
  create table session (id uuid primary key default gen_random_uuid(), expires_at timestamptz not null, token text not null unique,
    ip_address text, user_agent text, user_id uuid not null references users(id) on delete cascade,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table account (id uuid primary key default gen_random_uuid(), account_id text not null, provider_id text not null,
    user_id uuid not null references users(id) on delete cascade, access_token text, refresh_token text, id_token text,
    access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table verification (id uuid primary key default gen_random_uuid(), identifier text not null, value text not null,
    expires_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
`

export async function setup() {
  const client = new PGlite()
  await client.exec(SCHEMA_SQL)
  const db = createDatabase(drizzle({ client, relations }), { driver: 'postgres' })
  setDefaultDatabase(() => db)
  const ann = await User.create({ name: 'Ann', email: 'ann@example.test' })
  const bob = await User.create({ name: 'Bob', email: 'bob@example.test', plan: 'pro' })
  const admin = await User.create({ name: 'Root', email: 'root@example.test', isAdmin: true })
  const draft = await Post.create({ slug: 'draft', authorId: ann.id })
  const live = await Post.create({ slug: 'live', authorId: ann.id, published: true })
  calls.update = 0
  calls.prefetch = 0
  return { ann, bob, admin, draft, live }
}
