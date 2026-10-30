import { PGlite } from '@electric-sql/pglite'
import { createDatabase, defineModel, setDefaultDatabase, type Row } from '@caldera/db'
import { defineRelations } from 'drizzle-orm'
import { boolean, snakeCase, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { allow, defineAbility, definePolicy, deny, denyAsNotFound } from '../src/index.js'

export const users = snakeCase.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  isAdmin: boolean().notNull().default(false),
  plan: text().notNull().default('free'),
})
export const posts = snakeCase.table('posts', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  authorId: uuid().notNull(),
  published: boolean().notNull().default(false),
  secret: boolean().notNull().default(false),
})
export const relations = defineRelations({ users, posts }, (r) => ({
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
})

export const viewBilling = defineAbility('viewBilling', (user) => user.plan === 'pro')
export const viewStatus = defineAbility('viewStatus', { guest: true, check: () => true })

declare module '@caldera/db' {
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

export async function setup() {
  const client = new PGlite()
  await client.exec(`
    create table users (id uuid primary key default gen_random_uuid(), name text not null, is_admin boolean not null default false, plan text not null default 'free');
    create table posts (id uuid primary key default gen_random_uuid(), slug text not null unique, author_id uuid not null, published boolean not null default false, secret boolean not null default false);
  `)
  const db = createDatabase(drizzle({ client, relations }), { driver: 'postgres' })
  setDefaultDatabase(() => db)
  const ann = await User.create({ name: 'Ann' })
  const bob = await User.create({ name: 'Bob', plan: 'pro' })
  const admin = await User.create({ name: 'Root', isAdmin: true })
  const draft = await Post.create({ slug: 'draft', authorId: ann.id })
  const live = await Post.create({ slug: 'live', authorId: ann.id, published: true })
  calls.update = 0
  calls.prefetch = 0
  return { ann, bob, admin, draft, live }
}
