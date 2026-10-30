import { AsyncLocalStorage } from 'node:async_hooks'
import { Hono } from 'hono'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  BootError,
  createApp,
  defineProvider,
  EnvValidationError,
  NotBootedError,
  REDACTED,
  type HonoEnvOf,
} from '../src/index.js'
import { config, env, validEnv } from './fixture.js'

class FakeDb {
  constructor(readonly url: string) {}
}

function makeProviders() {
  const built = vi.fn()
  const calls: string[] = []
  const db = defineProvider({
    name: 'db',
    register: (app) => ({
      db: app.singleton(() => {
        built()
        return new FakeDb(app.config.database.url)
      }),
      dbName: 'primary',
    }),
    boot: () => void calls.push('boot:db'),
    shutdown: () => void calls.push('shutdown:db'),
  })
  const users = defineProvider({
    name: 'users',
    dependsOn: [db],
    register: (app) => ({ users: { find: (id: string) => ({ id, from: app.services.dbName }) } }),
    request: {
      requestId: (c) => c.req.header('x-request-id') ?? 'none',
      currentUserId: (c, services) => `${services.dbName}:${c.req.query('user') ?? 'guest'}`,
    },
    boot: () => void calls.push('boot:users'),
    shutdown: () => void calls.push('shutdown:users'),
  })
  return { db, users, built, calls }
}

describe('env', () => {
  it('validates, applies defaults and treats empty strings as unset', () => {
    const parsed = env.parse({ ...validEnv, PORT: '', FEATURE_FLAGS: '' })
    expect(parsed.PORT).toBe(3000)
    expect(parsed.FEATURE_FLAGS).toBeUndefined()
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it('reports every invalid key without leaking values', () => {
    const error = (() => {
      try {
        env.parse({ APP_URL: 'not a url', APP_KEY: 'short-but-secret' })
      } catch (e) {
        return e as EnvValidationError
      }
    })()
    expect(error).toBeInstanceOf(EnvValidationError)
    expect(error!.code).toBe('env_invalid')
    expect(error!.details.issues.map((i) => i.key).sort()).toEqual(['APP_KEY', 'APP_URL', 'DATABASE_URL'])
    expect(error!.message).not.toContain('short-but-secret')
  })

  it('marks secrets explicitly and by name', () => {
    expect(env.isSecret('APP_KEY')).toBe(true)
    expect(env.isSecret('DATABASE_URL')).toBe(true)
    expect(env.isSecret('APP_URL')).toBe(false)
  })
})

describe('createApp', () => {
  it('resolves typed, frozen config at boot', async () => {
    const app = createApp({ env, config })
    expect(() => app.config).toThrow(NotBootedError)
    await app.boot({ env: validEnv })
    expect(app.config.database.pool.max).toBe(10)
    expect(app.config.site.port).toBe(8080)
    expect(Object.isFrozen(app.config.database.pool)).toBe(true)
    expectTypeOf(app.config.site.port).toEqualTypeOf<number>()
    // @ts-expect-error unknown config name
    void app.config.mail
  })

  it('orders providers by dependency and includes undeclared dependencies', async () => {
    const { users, calls } = makeProviders()
    const app = createApp({ env, config, providers: [users] })
    await app.boot({ env: validEnv })
    expect(calls).toEqual(['boot:db', 'boot:users'])
    expect(app.describe().providers.map((p) => p.name)).toEqual(['db', 'users'])
  })

  it('builds singletons lazily and once', async () => {
    const { db, users, built } = makeProviders()
    const app = createApp({ env, config, providers: [db, users] })
    await app.boot({ env: validEnv })
    expect(built).not.toHaveBeenCalled()
    expect(app.services.db.url).toContain('db.internal')
    expect(app.services.db).toBe(app.services.db)
    expect(built).toHaveBeenCalledTimes(1)
    expect(app.services.users.find('7')).toEqual({ id: '7', from: 'primary' })
    expectTypeOf(app.services.db).toEqualTypeOf<FakeDb>()
  })

  it('shares one boot between concurrent callers', async () => {
    const register = vi.fn(() => ({}))
    const app = createApp({ env, providers: [defineProvider({ name: 'p', register })] })
    await Promise.all([app.boot({ env: validEnv }), app.boot({ env: validEnv }), app.boot({ env: validEnv })])
    expect(register).toHaveBeenCalledTimes(1)
    expect(app.state).toBe('booted')
  })

  it('can retry after a failed boot', async () => {
    const app = createApp({ env, config })
    await expect(app.boot({ env: {} })).rejects.toBeInstanceOf(EnvValidationError)
    expect(app.state).toBe('created')
    await app.boot({ env: validEnv })
    expect(app.state).toBe('booted')
  })

  it('rejects provider cycles, duplicate services and undeclared dependencies', async () => {
    const a = defineProvider({ name: 'a', dependsOn: [] as never[] })
    const b = defineProvider({ name: 'b', dependsOn: [a] })
    ;(a.dependsOn as unknown[]).push(b)
    expect(() => createApp({ env, providers: [a] })).toThrow(/cycle: a → b → a/)

    const one = defineProvider({ name: 'one', register: () => ({ cache: 1 }) })
    const two = defineProvider({ name: 'two', register: () => ({ cache: 2 }) })
    await expect(createApp({ env, providers: [one, two] }).boot({ env: validEnv })).rejects.toThrow(/"cache" is registered by both "one" and "two"/)

    const sneaky = defineProvider({
      name: 'sneaky',
      register: (app) => ({ peek: (app.services as Record<string, unknown>).cache }),
    })
    await expect(createApp({ env, providers: [one, sneaky] }).boot({ env: validEnv })).rejects.toThrow(/Add "one" to dependsOn/)
  })

  it('shuts providers down in reverse order', async () => {
    const { users, calls } = makeProviders()
    const app = createApp({ env, config, providers: [users] })
    await app.boot({ env: validEnv })
    await app.shutdown()
    expect(calls).toEqual(['boot:db', 'boot:users', 'shutdown:users', 'shutdown:db'])
    await expect(app.boot()).rejects.toBeInstanceOf(BootError)
  })
})

describe('middleware', () => {
  function makeHttpApp() {
    const { db, users } = makeProviders()
    const app = createApp({ env, config, providers: [db, users], asyncContext: AsyncLocalStorage })
    const http = new Hono<HonoEnvOf<typeof app>>()
      .use(app.middleware())
      .get('/whoami', async (c) => {
        await new Promise((r) => setTimeout(r, Number(c.req.query('delay') ?? 0)))
        return c.json({
          requestId: c.var.requestId,
          user: c.var.currentUserId,
          db: c.var.db.url,
          scopedRequestId: app.current()?.context.req.header('x-request-id') ?? null,
        })
      })
    return { app, http }
  }

  it('boots lazily from Workers-style bindings and exposes typed services on c.var', async () => {
    const { app, http } = makeHttpApp()
    expect(app.state).toBe('created')
    const res = await http.request('/whoami?user=ann', { headers: { 'x-request-id': 'r1' } }, validEnv)
    expect(app.state).toBe('booted')
    expect(await res.json()).toEqual({ requestId: 'r1', user: 'primary:ann', db: validEnv.DATABASE_URL, scopedRequestId: 'r1' })
  })

  it('keeps request-scoped services and app.current() isolated between concurrent requests', async () => {
    const { http } = makeHttpApp()
    const [slow, fast] = await Promise.all([
      http.request('/whoami?user=slow&delay=20', { headers: { 'x-request-id': 'slow' } }, validEnv),
      http.request('/whoami?user=fast&delay=1', { headers: { 'x-request-id': 'fast' } }, validEnv),
    ])
    expect(await slow.json()).toMatchObject({ requestId: 'slow', user: 'primary:slow', scopedRequestId: 'slow' })
    expect(await fast.json()).toMatchObject({ requestId: 'fast', user: 'primary:fast', scopedRequestId: 'fast' })
  })

  it('types c.var from the providers', () => {
    const { app } = makeHttpApp()
    new Hono<HonoEnvOf<typeof app>>().get('/', (c) => {
      expectTypeOf(c.var.db).toEqualTypeOf<FakeDb>()
      expectTypeOf(c.var.requestId).toEqualTypeOf<string>()
      // @ts-expect-error not a registered service
      void c.var.mailer
      return c.text('ok')
    })
  })
})

describe('describe()', () => {
  it('is JSON-safe, redacts secrets and builds no services', async () => {
    const { db, users, built } = makeProviders()
    const app = createApp({ env, config, providers: [db, users] })
    await app.boot({ env: validEnv })
    const description = JSON.parse(JSON.stringify(app.describe()))

    expect(built).not.toHaveBeenCalled()
    expect(description.schemaVersion).toBe(1)
    expect(description.config.database.url).toBe(REDACTED) // DATABASE_URL is secret by name
    expect(description.config.site.signingKey).toBe(REDACTED) // APP_KEY marked with secret()
    expect(description.config.site.url).toBe('https://example.test')
    expect(JSON.stringify(description)).not.toContain('hunter2')
    expect(description.env.keys).toContainEqual({ name: 'FEATURE_FLAGS', secret: false, present: false })
    expect(description.env.schema.properties.PORT).toBeDefined()
    expect(description.providers).toEqual([
      {
        name: 'db',
        dependsOn: [],
        services: [
          { name: 'db', lifetime: 'singleton' },
          { name: 'dbName', lifetime: 'value' },
        ],
        hooks: { boot: true, shutdown: true },
      },
      {
        name: 'users',
        dependsOn: ['db'],
        services: [
          { name: 'users', lifetime: 'value' },
          { name: 'requestId', lifetime: 'request' },
          { name: 'currentUserId', lifetime: 'request' },
        ],
        hooks: { boot: true, shutdown: true },
      },
    ])
  })

  it('works before boot without config values', () => {
    const description = createApp({ env, config }).describe()
    expect(description.state).toBe('created')
    expect(description.config).toBeNull()
    expect(description.env.keys.every((k) => k.present === null)).toBe(true)
  })
})
