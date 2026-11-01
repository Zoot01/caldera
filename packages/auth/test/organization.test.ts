import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createApp, defineEnv } from '@caldera-js/core'
import { databaseProvider } from '@caldera-js/db'
import { defineMiddleware, errorHandler } from '@caldera-js/http'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { getAuthTables } from 'better-auth/db'
import { organization } from 'better-auth/plugins'
import { createAccessControl } from 'better-auth/plugins/access'
import { defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access'
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres'
import { defineRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { authenticate, authorizationProvider, authRoutes, betterAuthProvider, defineAbility, generateAuthSchema, type Gate } from '../src/index.js'
import { organizationGate } from '../src/organization.js'
import { posts, User, users } from './fixtures.js'

const ORIGIN = 'http://localhost:3000'
const ac = createAccessControl({ ...defaultStatements, post: ['create', 'update'] })
const roles = {
  owner: ac.newRole({ ...ownerAc.statements, post: ['create', 'update'] }),
  member: ac.newRole({ ...memberAc.statements, post: [] }),
}
const authOptions = { plugins: [organization({ ac, roles })], user: { modelName: 'users' }, advanced: { database: { generateId: 'uuid' as const } } }
const createPost = defineAbility('createPost', (_user, g) => g.org.has({ post: ['create'] }))

let generated: ReturnType<typeof generateAuthSchema>
let schemaFile: string

beforeAll(async () => {
  generated = generateAuthSchema(getAuthTables(authOptions as never) as never, { dialect: 'pg', idType: 'uuid' })
  const dir = join(import.meta.dirname, '.tmp')
  mkdirSync(dir, { recursive: true })
  schemaFile = join(dir, `auth-schema-${process.pid}.ts`)
  writeFileSync(schemaFile, generated.code)
})

describe('caldera auth:schema generator', () => {
  it('generates every table plugins need, without the app-owned users table', () => {
    expect(generated.tables).toEqual(['session', 'account', 'verification', 'organization', 'member', 'invitation'])
    expect(generated.code).toContain("snakeCase.table('member', {")
    expect(generated.code).toMatch(/activeOrganizationId: text\(\)/) // the plugin's extra session field
    expect(generated.code).toContain("userId: uuid().notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' })")
    expect(generated.code).not.toContain("snakeCase.table('users'")
    expect(generated.userFields).toEqual([])
  })
})

describe('g.org with Better Auth organizations', () => {
  async function makeServer() {
    const { authSchema } = (await import(schemaFile)) as { authSchema: (u: typeof users) => Record<string, never> }
    const tables = authSchema(users)
    const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ users, posts, ...tables }))
    const client = new PGlite()
    for (const statement of statements) await client.exec(statement)

    const mw = defineMiddleware({ auth: () => authenticate() })
    const app = createApp({
      env: defineEnv({}),
      providers: [
        databaseProvider({ driver: 'postgres', connect: () => drizzle({ client, relations: defineRelations({ users, posts, ...tables }) }) }),
        betterAuthProvider({
          userModel: User,
          create: ({ db }) =>
            betterAuth({
              ...authOptions,
              baseURL: ORIGIN,
              secret: 'test-secret-0123456789-abcdefghijklmnop',
              logger: { disabled: true },
              database: drizzleAdapter(db as never, { provider: 'pg', schema: { users, ...tables } }),
              emailAndPassword: { enabled: true },
            }),
        }),
        authorizationProvider({ extend: organizationGate({ roles }) }),
      ],
    })
    const http = new Hono()
      .use(app.middleware())
      .route('/', authRoutes())
      .get('/can-create', mw.auth().handler, async (c) => {
        const gate = (c.var as unknown as { gate: Gate }).gate
        return c.json({ org: (c.var as { authSession?: { activeOrganizationId?: string | null } }).authSession?.activeOrganizationId ?? null, allowed: await gate.can(createPost) })
      })
      .onError(errorHandler())
    await app.boot({ env: {} })
    return { http, auth: app.services.auth }
  }

  it('grants permissions by the member’s role in the active organization', async () => {
    const { http, auth } = await makeServer()
    const signUp = async (email: string) => {
      const res = await http.request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ name: email, email, password: 'correct-horse-battery' }),
      })
      const body = (await res.json()) as { user: { id: string } }
      return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, id: body.user.id }
    }
    const canCreate = async (cookie: string) => (await (await http.request(`${ORIGIN}/can-create`, { headers: { cookie } })).json()) as { org: string | null; allowed: boolean }

    const ann = await signUp('ann@example.test')
    const bob = await signUp('bob@example.test')
    expect(await canCreate(ann.cookie)).toEqual({ org: null, allowed: false }) // no active organization yet

    const org = await auth.api.createOrganization({ headers: new Headers({ cookie: ann.cookie }), body: { name: 'Acme', slug: 'acme' } })
    await auth.api.setActiveOrganization({ headers: new Headers({ cookie: ann.cookie }), body: { organizationId: org!.id } })
    expect(await canCreate(ann.cookie)).toEqual({ org: org!.id, allowed: true }) // owner

    await auth.api.addMember({ body: { userId: bob.id, role: 'member', organizationId: org!.id } })
    await auth.api.setActiveOrganization({ headers: new Headers({ cookie: bob.cookie }), body: { organizationId: org!.id } })
    expect(await canCreate(bob.cookie)).toEqual({ org: org!.id, allowed: false }) // plain member
  }, 30_000) // password hashing and in-WASM Postgres are slow under a full parallel run
})
