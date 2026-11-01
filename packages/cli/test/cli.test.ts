import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { check, describeAbilities, describeModel, generateProjectAuthSchema, describeProject, describeSchema, generate, listRoutes, openProject, runMigrations, sqliteWal } from '../src/index.js'

const here = import.meta.dirname
const bin = join(here, '../bin/caldera.js')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
// Copies stay at test/.tmp/<name> (the fixtures' tsconfig extends the base config by relative path),
// and each test file only cleans up its own prefix: files run in parallel.
const tmp = join(here, '.tmp')
const PREFIX = 'cli-'
let root: string

// Each test gets a fresh copy inside test/.tmp so node_modules resolution still works.
beforeEach(() => {
  root = join(tmp, `${PREFIX}app-${Math.random().toString(36).slice(2)}`)
  // Skip any .caldera/ generated in the fixture for editor support: tests start ungenerated.
  cpSync(join(here, 'fixtures/basic-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') && !src.includes('/drizzle/') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

function typecheck(dir: string) {
  return spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' })
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args, '--cwd', root, '--json'], { encoding: 'utf8' })
  return { code: result.status, json: JSON.parse(result.stdout) as Record<string, any> }
}

describe('caldera generate', () => {
  it('writes the config barrel and the Register augmentation', async () => {
    const result = await generate(openProject(root))
    expect(result.files.map((f) => [f.path, f.status])).toEqual([
      ['.caldera/config.gen.ts', 'created'],
      ['.caldera/register.d.ts', 'created'],
      ['.caldera/routes.gen.ts', 'created'],
      ['.caldera/policies.gen.ts', 'created'],
      ['.caldera/.gitignore', 'created'],
      ['AGENTS.md', 'updated'],
    ])
    const register = readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')
    expect(register).toContain(`declare module '@caldera-js/db'`)
    expect(register).toContain('    posts: typeof models0.default\n    users: typeof models1.User\n')
    expect(register).toContain(`declare module '@caldera-js/auth'`)
    expect(register).toContain('    user: Row<typeof models1.User>\n')
    expect(register).toContain('    post: typeof policies0.PostPolicy\n')
    const routes = readFileSync(join(root, '.caldera/routes.gen.ts'), 'utf8')
    expect(routes).toContain('export const router = createRouter(routes0.default, routes1.posts)')
    const barrel = readFileSync(join(root, '.caldera/config.gen.ts'), 'utf8')
    expect(barrel).toContain(`import * as config0 from '../src/config/database.js'`)
    expect(barrel).toContain('export const config = [config0.database, config1.default] as const')
    expect(readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')).toContain('interface Register')
  })

  it('makes env and config typed everywhere, which fails without it', async () => {
    // Without generated files the app can't even import its config barrel.
    expect(typecheck(root).status).not.toBe(0)

    await generate(openProject(root))
    const withRegister = typecheck(root)
    expect(withRegister.stdout + withRegister.stderr).toBe('')
    expect(withRegister.status).toBe(0)

    // Without the @caldera-js/db half, model queries lose their relational types.
    const register = readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')
    writeFileSync(join(root, '.caldera/register.d.ts'), register.slice(0, register.indexOf("\nimport type { relations }")))
    expect(typecheck(root).stdout).toMatch(/type-checks\.ts\(\d+,\d+\): error/)
    writeFileSync(join(root, '.caldera/register.d.ts'), register)
    expect(withRegister.status).toBe(0)

    // Keep the barrel but drop the Register augmentation: env becomes untyped again.
    rmSync(join(root, '.caldera/register.d.ts'))
    expect(typecheck(root).stdout).toMatch(/Property 'DATABASE_URL' does not exist on type 'NotGenerated'/)
  }, 30_000)

  it('is idempotent, and --check reports drift without writing', async () => {
    const project = openProject(root)
    await generate(project)
    expect((await generate(project)).files.every((f) => f.status === 'unchanged')).toBe(true)

    writeFileSync(
      join(root, 'src/config/mail.ts'),
      `import { defineConfig } from '@caldera-js/core'\nexport const mail = defineConfig('mail', () => ({ from: 'hi@example.test' }))\n`,
    )
    const check = await generate(project, { check: true })
    expect(check.stale).toBe(true)
    expect(check.files.find((f) => f.path.endsWith('config.gen.ts'))?.status).toBe('stale')
    expect(readFileSync(join(root, '.caldera/config.gen.ts'), 'utf8')).not.toContain('mail')
  })

  it('rejects two config files using the same name', async () => {
    writeFileSync(
      join(root, 'src/config/site-copy.ts'),
      `import { defineConfig } from '@caldera-js/core'\nexport const again = defineConfig('site', () => ({}))\n`,
    )
    await expect(generate(openProject(root))).rejects.toThrow(/Config "site" is defined in both/)
  })
})

describe('caldera describe', () => {
  beforeEach(async () => {
    await generate(openProject(root))
  })

  it('boots with .env, redacts secrets and never builds singletons', async () => {
    const description = await describeProject(openProject(root))
    expect(description.state).toBe('booted')
    expect(description.config).toMatchObject({
      database: { url: '[redacted]', pool: { max: 5 } },
      site: { url: 'https://fixture.test', port: 3000 },
    })
    expect(JSON.stringify(description)).not.toContain('pw-from-dotenv')
    expect(description.providers[0]!.services).toEqual([
      { name: 'db', lifetime: 'singleton' },
      { name: 'databaseUrl', lifetime: 'value' },
      { name: 'requestId', lifetime: 'request' },
    ])
  })

  it('works end to end through the binary, as JSON', () => {
    execFileSync('pnpm', ['-C', join(here, '..'), 'build'], { stdio: 'ignore' })
    const { code, json } = cli('describe')
    expect(code).toBe(0)
    expect(json.schemaVersion).toBe(1)
    expect(json.env.keys.find((k: { name: string }) => k.name === 'APP_KEY')).toEqual({ name: 'APP_KEY', secret: true, present: true })
  }, 30_000)

  it('reports failures as a JSON error with a stable code', () => {
    rmSync(join(root, 'src/app.ts'))
    const { code, json } = cli('describe')
    expect(code).toBe(1)
    expect(json.error).toMatchObject({ code: 'missing_file', details: { file: 'src/app.ts' } })
    expect(existsSync(join(root, 'src/app.ts'))).toBe(false)
  })
})

describe('caldera route:list', () => {
  it('lists every route with relative source locations and input schemas', async () => {
    // Through the real CLI: in-process, Vitest's own stack handling hides the loader's source maps.
    await generate(openProject(root))
    const { routes } = cli('route:list').json as Awaited<ReturnType<typeof listRoutes>>
    expect(routes.map((r) => `${r.method} ${r.path} ${r.name}`)).toEqual(['GET /health health.check', 'GET /posts posts.index', 'GET /posts/:post posts.show'])
    const show = routes.find((r) => r.name === 'posts.show')!
    expect(show.params).toEqual(['post'])
    expect(show.source).toEqual({ file: 'src/routes/posts.ts', line: 7 })
    expect(show.bindings).toEqual({ post: 'post' })
    expect(show.authorize).toEqual({ ability: 'post.view', param: 'post' })
  })

  it('reports duplicate route names across files', async () => {
    writeFileSync(
      join(root, 'src/routes/copy.ts'),
      `import { defineRoutes } from '@caldera-js/http'\nexport const again = defineRoutes('health').get('check', '/other', (c) => c.text(''))\n`,
    )
    await expect(listRoutes(openProject(root))).rejects.toThrow(/Route "health.check" is defined in both src\/routes\/copy.ts and src\/routes\/health.ts/)
  })

  it('prints JSON through the binary', () => {
    const { code, json } = cli('route:list')
    expect(code).toBe(0)
    expect(json.schemaVersion).toBe(1)
    expect(json.routes).toHaveLength(3)
  })
})

describe('caldera model:show and db:schema', () => {
  it('describes a model with hidden columns, relations and its source file', async () => {
    const user = await describeModel(openProject(root), 'user')
    expect(user).toMatchObject({ name: 'user', key: 'users', table: 'users', file: 'src/models/user.ts', primaryKey: 'id', routeKey: 'id', hidden: ['passwordHash'] })
    expect(user.columns.find((c) => c.name === 'passwordHash')).toMatchObject({ column: 'password_hash', type: 'text', hidden: true, nullable: false })
    expect(user.columns.find((c) => c.name === 'id')).toMatchObject({ primary: true, type: 'uuid', hasDefault: true })
    expect(user.relations).toEqual([{ name: 'posts', type: 'many', target: 'posts', model: 'post' }])

    // The class-style name make:model takes finds it too.
    expect((await describeModel(openProject(root), 'User')).name).toBe('user')
    const post = await describeModel(openProject(root), 'posts')
    expect(post).toMatchObject({ name: 'post', routeKey: 'slug', appends: ['url'] })
  })

  it('lists known models when asked for an unknown one', async () => {
    await expect(describeModel(openProject(root), 'comment')).rejects.toThrow(/Known models: post, user/)
    const { code, json } = cli('model:show', 'comment')
    expect(code).toBe(1)
    expect(json.error).toMatchObject({ code: 'unknown_model', details: { known: ['post', 'user'] } })
  })

  it('describes every table with its model', async () => {
    const { tables } = await describeSchema(openProject(root))
    expect(tables.map((t) => [t.key, t.model, t.columns.length])).toEqual([
      ['users', 'user', 3],
      ['posts', 'post', 4],
    ])
    expect(tables[1]!.relations).toEqual([{ name: 'author', type: 'one', target: 'users' }])
  })
})

describe('caldera db:generate / db:migrate / db:push', () => {
  it('generates SQL migrations with the project’s drizzle-kit', () => {
    // --name names the migration (drizzle-kit's own flag, without needing `--` before it).
    const { code, json } = cli('db:generate', '--name', 'create-users')
    expect(json.error).toBeUndefined()
    expect(code).toBe(0)
    const migrations = readdirSync(join(root, 'drizzle'), { recursive: true }) as string[]
    expect(migrations.some((f) => /^\d{14}_create-users$/.test(f))).toBe(true)
    const sql = migrations.filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(root, 'drizzle', f), 'utf8')).join('\n')
    expect(sql).toMatch(/CREATE TABLE "users"/)
    expect(sql).toMatch(/"password_hash" text NOT NULL/)
  }, 60_000)

  it('refuses database-changing commands in production without --force', () => {
    expect(() => runMigrations(openProject(root), 'migrate', { env: { NODE_ENV: 'production' } })).toThrow(/Pass --force/)
    expect(() => runMigrations(openProject(root), 'push', { env: { NODE_ENV: 'production' } })).toThrow(/Pass --force/)
    // generate only writes files, so it is allowed.
    expect(() => runMigrations(openProject(root), 'generate', { env: { ...process.env, NODE_ENV: 'production' }, capture: true })).not.toThrow()
  }, 60_000)

  it('explains a missing drizzle-kit or config file', () => {
    const outside = mkdtempSync(join(tmpdir(), 'caldera-no-kit-'))
    try {
      writeFileSync(join(outside, 'drizzle.config.ts'), 'export default {}\n')
      expect(() => runMigrations(openProject(outside), 'generate')).toThrow(/drizzle-kit is not installed/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    rmSync(join(root, 'drizzle.config.ts'))
    expect(cli('db:generate').json.error).toMatchObject({ code: 'missing_file', details: { file: 'drizzle.config.ts' } })
  })
})

describe('db:migrate on a local SQLite file', () => {
  it('puts it in WAL mode, so the app, worker and scheduler can share it; other databases are left alone', async () => {
    const dir = join(tmp, `${PREFIX}wal-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ "name": "wal-app" }\n')
    try {
      expect(await sqliteWal(openProject(dir), { DATABASE_URL: 'file:app.db' })).toBe('wal')
      expect(existsSync(join(dir, 'app.db'))).toBe(true)
      expect(await sqliteWal(openProject(dir), { DATABASE_URL: 'postgres://localhost/app' })).toBeUndefined()
      expect(await sqliteWal(openProject(dir), { DATABASE_URL: 'libsql://app.turso.io' })).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('caldera db:seed', () => {
  const seedApp = join(here, 'fixtures/seed-app')
  const seed = (...args: string[]) => {
    const result = spawnSync(process.execPath, [bin, 'db:seed', '--cwd', seedApp, '--json', ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', CALDERA_ENV: '' },
    })
    return { code: result.status, json: JSON.parse(result.stdout) as Record<string, any> }
  }

  it('boots the app, runs seeders in dependency order and reports the seed', () => {
    const { code, json } = seed('--seed', '99')
    expect(json.error).toBeUndefined()
    expect(code).toBe(0)
    expect(json.seed).toBe(99)
    expect(json.environment).toBe('test')
    // Dependencies first; otherwise file order, then export order (alphabetical within a module).
    expect(json.seeders.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ['schema', 'ran'],
      ['demo', 'skipped'],
      ['users', 'ran'],
    ])
    // Same seed, same data.
    const users = (report: Record<string, any>) => report.seeders.find((s: { name: string }) => s.name === 'users').logs
    expect(users(json)[0]).toMatch(/^users: .+ \| .+ \| .+$/)
    expect(users(seed('--seed', '99').json)).toEqual(users(json))
  }, 60_000)

  it('runs a subset with --only and refuses production without --force', () => {
    expect(seed('--only', 'schema').json.seeders.map((s: { name: string }) => s.name)).toEqual(['schema'])
    const result = spawnSync(process.execPath, [bin, 'db:seed', '--cwd', seedApp, '--json'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } })
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: 'confirmation_required' })
  }, 60_000)
})

describe('caldera abilities', () => {
  it('lists policy abilities with the routes they guard, and standalone abilities', async () => {
    const data = await describeAbilities(openProject(root))
    expect(data.policies).toEqual([
      {
        model: 'post',
        file: 'src/policies/post.ts',
        before: false,
        scope: false,
        prefetch: false,
        abilities: [
          { name: 'post.view', ability: 'view', takesRow: true, guest: true, routes: ['posts.show'] },
          { name: 'post.update', ability: 'update', takesRow: true, guest: false, routes: [] },
        ],
      },
    ])
    expect(data.abilities).toEqual([{ name: 'viewStats', guest: false, file: 'src/policies/post.ts' }])
    const { code, json } = cli('abilities')
    expect(code).toBe(0)
    expect(json.policies[0].model).toBe('post')
  })
})

describe('caldera auth:schema', () => {
  let authApp: string
  beforeEach(() => {
    authApp = join(tmp, `${PREFIX}auth-${Math.random().toString(36).slice(2)}`)
    cpSync(join(here, 'fixtures/auth-app'), authApp, { recursive: true })
  })
  afterEach(() => rmSync(authApp, { recursive: true, force: true }))

  it('writes plugin tables from the app’s Better Auth config and lists user fields to add', async () => {
    const result = await generateProjectAuthSchema(openProject(authApp))
    expect(result).toMatchObject({ status: 'created', dialect: 'pg', file: 'src/db/auth-schema.ts' })
    expect(result.tables).toEqual(['session', 'account', 'verification', 'organization', 'member', 'invitation'])
    expect(result.userFields.map((f) => f.name)).toEqual(['role', 'banned', 'banReason', 'banExpires'])
    const code = readFileSync(join(authApp, 'src/db/auth-schema.ts'), 'utf8')
    expect(code).toContain('impersonatedBy') // admin plugin's session field
    expect(code).toContain('uuid().primaryKey().defaultRandom()') // generateId: 'uuid'
  }, 60_000)

  it('check boots a fresh app for each deploy target after checking the auth schema', async () => {
    await generateProjectAuthSchema(openProject(authApp))
    writeFileSync(join(authApp, 'vercel.json'), '{}\n')
    mkdirSync(join(authApp, '.vercel'), { recursive: true })
    writeFileSync(join(authApp, '.vercel/.env.production.local'), 'QUEUE_CONNECTION=sync\n')
    const codes = (await check(openProject(authApp))).issues.map((i) => i.code)
    expect(codes).not.toContain('app_shut_down')
    expect(codes).toContain('vercel_local_database')
  }, 60_000)

  it('reports drift with --check and is unchanged on rerun', async () => {
    const check = spawnSync(process.execPath, [bin, 'auth:schema', '--cwd', authApp, '--json', '--check'], { encoding: 'utf8' })
    expect(check.status).toBe(1)
    expect(JSON.parse(check.stdout)).toMatchObject({ status: 'stale' })
    expect(existsSync(join(authApp, 'src/db/auth-schema.ts'))).toBe(false)

    await generateProjectAuthSchema(openProject(authApp))
    expect((await generateProjectAuthSchema(openProject(authApp), { check: true })).status).toBe('unchanged')
  }, 60_000)
})

describe('AGENTS.md and caldera check', () => {
  it('rebuilds only the generated section of AGENTS.md from the code', async () => {
    // Through the real CLI, for the source lines (see route:list above).
    expect(cli('generate').code).toBe(0)
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(agents).toMatch(/^# Fixture app\n\nHand-written guidance that must survive regeneration\./)
    expect(agents).toMatch(/More hand-written notes after the markers\.\n$/)
    expect(agents).toContain('| GET | `/posts/:post` | `posts.show` | `post.view` | src/routes/posts.ts:7 |')
    expect(agents).toContain('| `user` | `users` | passwordHash |  | src/models/user.ts |')
    expect(agents).toContain('| `post.view` | yes | `posts.show` | src/policies/post.ts |')
    expect(agents).toContain('| `viewStats` | no |  | src/policies/post.ts |')
  })

  it('passes when everything is generated, and reports what drifted', async () => {
    expect((await check(openProject(root))).issues.map((i) => i.file)).toEqual(['.caldera/config.gen.ts', '.caldera/register.d.ts', '.caldera/routes.gen.ts', '.caldera/policies.gen.ts', '.caldera/.gitignore', 'AGENTS.md'])
    await generate(openProject(root))
    expect(await check(openProject(root))).toEqual({ schemaVersion: 1, ok: true, issues: [] })

    writeFileSync(join(root, 'src/routes/health.ts'), `import { defineRoutes } from '@caldera-js/http'\nexport default defineRoutes('health').get('check', '/healthz', (c) => c.text('ok'))\n`)
    const result = await check(openProject(root))
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([{ code: 'stale_generated', message: 'AGENTS.md is out of date with the code.', file: 'AGENTS.md', fix: 'caldera generate' }])

    const { code, json } = cli('check')
    expect(code).toBe(1)
    expect(json.issues[0].fix).toBe('caldera generate')
  })

  it('turns configuration errors into issues instead of crashing', async () => {
    writeFileSync(join(root, 'src/models/orphan.ts'), `import { defineModel } from '@caldera-js/db'\nimport { snakeCase, text } from 'drizzle-orm/pg-core'\nexport const Orphan = defineModel(snakeCase.table('orphans', { id: text().primaryKey() }), { name: 'orphan' })\n`)
    const result = await check(openProject(root))
    expect(result.issues).toEqual([expect.objectContaining({ code: 'model_definition', message: expect.stringMatching(/Model "orphan" .* isn't in src\/db\/relations\.ts/) })])
  })
})
