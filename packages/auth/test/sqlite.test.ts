// Runtime-only (excluded from typecheck): the type registry holds the Postgres fixture schema.
import { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { defineRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { snakeCase, text } from 'drizzle-orm/sqlite-core'
import { expect, it } from 'vitest'
import { authTables, authUserColumns } from '../src/sqlite.js'

const users = snakeCase.table('users', { ...authUserColumns(), plan: text().notNull().default('free') })
const { session, account, verification } = authTables(users)

it('works with Better Auth on SQLite: sign-up, session lookup and app-owned users', async () => {
  const client = new DatabaseSync(':memory:')
  client.exec(`
    create table users (id text primary key, name text not null, email text not null unique, email_verified integer not null default 0,
      image text, created_at integer not null, updated_at integer not null, plan text not null default 'free');
    create table session (id text primary key, expires_at integer not null, token text not null unique, ip_address text, user_agent text,
      user_id text not null references users(id) on delete cascade, created_at integer not null, updated_at integer not null);
    create table account (id text primary key, account_id text not null, provider_id text not null, user_id text not null references users(id) on delete cascade,
      access_token text, refresh_token text, id_token text, access_token_expires_at integer, refresh_token_expires_at integer, scope text, password text,
      created_at integer not null, updated_at integer not null);
    create table verification (id text primary key, identifier text not null, value text not null, expires_at integer not null, created_at integer not null, updated_at integer not null);
  `)
  const db = drizzle({ client, relations: defineRelations({ users, session, account, verification }) })
  const auth = betterAuth({
    baseURL: 'http://localhost',
    secret: 'test-secret-0123456789-abcdefghijklmnop',
    logger: { disabled: true },
    database: drizzleAdapter(db, { provider: 'sqlite', schema: { users, session, account, verification } }),
    user: { modelName: 'users' },
    emailAndPassword: { enabled: true },
  })
  const res = await auth.handler(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ name: 'Ann', email: 'ann@example.test', password: 'correct-horse-battery' }),
    }),
  )
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!
  const current = await auth.api.getSession({ headers: new Headers({ cookie }) })
  expect(current?.user.email).toBe('ann@example.test')
  expect(client.prepare('select plan from users').get()).toEqual({ plan: 'free' })
})
