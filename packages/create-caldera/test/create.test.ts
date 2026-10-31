import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STUBS } from '../../cli/dist/stubs.js'
import { hasPostgres, startPostgres } from './postgres-server.js'
import { createProject, detectPackageManager, packageManagerVersion } from '../src/index.js'

const repo = join(import.meta.dirname, '../../..')
let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'create-caldera-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const offline = { install: false, git: false, env: { PATH: '' } }

/** The starter kit end to end over HTTP: registering signs in, and the dashboard renders. */
async function registersAndSignsIn(base: string) {
  const password = 'correct-horse-battery'
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ name: 'Ann', email: 'ann@example.test', password, passwordConfirmation: password }),
  })
  expect(res.status, await res.clone().text()).toBe(303)
  expect(res.headers.get('location')).toBe('/dashboard')
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const dashboard = await fetch(`${base}/dashboard`, { redirect: 'manual', headers: { cookie, accept: 'text/html' } })
  expect(dashboard.status).toBe(200)
  expect(await dashboard.text()).toContain('Dashboard')
  // Signed out, the dashboard sends people to the login page.
  expect((await fetch(`${base}/dashboard`, { redirect: 'manual', headers: { accept: 'text/html' } })).headers.get('location')).toBe('/login')
}

/**
 * The app's own browser tests (`test:browser`: Playwright against its build), as a developer runs
 * them, so without this runner's VITEST variables (they'd mark the app's test server as a test run).
 */
function runsBrowserTests(dir: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))
  const install = spawnSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], { cwd: dir, encoding: 'utf8', env })
  expect(install.status, install.stdout + install.stderr).toBe(0)
  const browser = spawnSync('pnpm', ['test:browser'], { cwd: dir, encoding: 'utf8', env })
  expect(browser.status, browser.stdout + browser.stderr).toBe(0)
  return browser.stdout
}

describe('createProject', () => {
  it('writes the bundled template with the name filled in and a fresh APP_KEY', async () => {
    const result = await createProject({ directory: join(base, 'My App'), ...offline, packageManager: 'pnpm' })
    const dir = result.directory
    expect(result.name).toBe('my-app')
    for (const file of ['.gitignore', '.env', '.env.example', 'AGENTS.md', 'src/app.ts', 'src/http.ts', 'src/routes/home.ts', 'tests/home.test.ts']) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
    expect(existsSync(join(dir, '_gitignore'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe('my-app')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('pnpm dev')
    const key = readFileSync(join(dir, '.env'), 'utf8').match(/^APP_KEY=(.+)$/m)![1]!
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const other = await createProject({ directory: join(base, 'second'), ...offline })
    expect(readFileSync(join(other.directory, '.env'), 'utf8')).not.toContain(key)
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toContain('APP_KEY=\n')
    // pnpm 11 fails installs with unapproved build scripts; esbuild's is approved up front.
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('esbuild: true')
    // bullmq's msgpackr-extract has a build script too; declined, or pnpm 11 fails the install.
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('msgpackr-extract: false')
    expect(existsSync(join(other.directory, 'pnpm-workspace.yaml'))).toBe(other.packageManager === 'pnpm')
  })

  it('makes a Next.js app: Next renders app/, Caldera serves /api, imports follow bundler resolution', async () => {
    const result = await createProject({ directory: join(base, 'next-app'), ...offline, packageManager: 'pnpm', frontend: 'next' })
    const dir = result.directory
    expect(result.frontend).toBe('next')
    for (const file of ['next.config.ts', 'app/page.tsx', 'app/actions.ts', 'app/api/[[...route]]/route.ts', 'src/app.ts', 'src/http.ts', 'vitest.config.ts']) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
    for (const file of ['resources', 'vite.config.ts', 'src/inertia.ts', 'src/server.ts']) expect(existsSync(join(dir, file)), file).toBe(false)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toMatchObject({ '@caldera/next': expect.any(String), next: expect.any(String) })
    expect(manifest.dependencies['@caldera/inertia']).toBeUndefined()
    expect(manifest.devDependencies.vite).toBeUndefined()
    expect(manifest.scripts).toMatchObject({ dev: 'caldera dev', build: 'next build', start: 'next start' })
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toContain("from '../.caldera/config.gen'")
    expect(readFileSync(join(dir, 'src/http.ts'), 'utf8')).toContain(".basePath('/api')")
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('with a Next.js frontend')
    expect(agents).not.toMatch(/resources\/pages|src\/inertia\.ts/)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.next')
  })

  it('layers a kit over the shared base: the starter by default, or blank', async () => {
    const starter = await createProject({ directory: join(base, 'starter'), ...offline })
    expect([starter.kit, starter.database, starter.target]).toEqual(['starter', 'sqlite', 'node'])
    const blank = await createProject({ directory: join(base, 'blank'), ...offline, kit: 'blank' })
    expect(blank.kit).toBe('blank')
    for (const dir of [starter.directory, blank.directory]) {
      for (const file of ['vite.config.ts', 'resources/app.tsx', 'src/inertia.ts', 'src/http.ts', 'src/server.ts', 'tests/home.test.ts', 'src/app.ts']) expect(existsSync(join(dir, file)), file).toBe(true)
    }
    expect((await createProject({ directory: join(base, 'next'), ...offline, frontend: 'next' })).kit).toBeNull()
  })

  it('gives Inertia apps Tailwind, coss ui as their own code, the `@/` alias and light/dark mode', async () => {
    const { directory: dir } = await createProject({ directory: join(base, 'ui'), ...offline, kit: 'blank' })
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    for (const file of ['components.json', 'resources/components/ui/card.tsx', 'resources/lib/utils.ts', 'resources/hooks/use-appearance.ts', 'resources/components/appearance-tabs.tsx']) expect(existsSync(join(dir, file)), file).toBe(true)
    expect(read('resources/app.css')).toContain('@custom-variant dark')
    expect(read('resources/app.css')).toContain("--font-sans: 'Instrument Sans Variable'")
    expect(JSON.parse(read('components.json')).registries).toEqual({ '@coss': 'https://coss.com/ui/r/{name}.json' })
    // Bundler resolution, as Vite resolves: `@/…` works (coss components import it), and imports have no extension.
    expect(read('tsconfig.json')).toMatch(/"moduleResolution": "Bundler"[\s\S]*"@\/\*": \["\.\/resources\/\*"\]/)
    expect(read('vite.config.ts')).toContain('tailwindcss()')
    expect(read('src/http.ts')).toContain("import { app } from './app'")
    expect(read('src/inertia.ts')).toContain('document: [appearance(), { head: () => \'<link rel="icon" href="/favicon.svg" type="image/svg+xml">\' }]')
    expect(existsSync(join(dir, 'public/favicon.svg'))).toBe(true)
    // The kit's package.json is merged into the app's, not copied over it.
    const manifest = JSON.parse(read('package.json'))
    expect(manifest.dependencies).toMatchObject({ '@base-ui/react': expect.any(String), '@caldera/inertia': expect.any(String), '@caldera/core': expect.any(String), 'lucide-react': expect.any(String) })
    expect(manifest.devDependencies).toMatchObject({ tailwindcss: expect.any(String), vite: expect.any(String), vitest: expect.any(String) })
    expect(manifest.scripts).toMatchObject({ build: 'vite build && vite build --ssr', dev: 'caldera dev' })
    expect(manifest).not.toHaveProperty('//')
    // The Next.js variant gets none of it.
    const next = await createProject({ directory: join(base, 'ui-next'), ...offline, frontend: 'next' })
    expect(existsSync(join(next.directory, 'components.json'))).toBe(false)
    const nextManifest = JSON.parse(readFileSync(join(next.directory, 'package.json'), 'utf8'))
    expect(nextManifest.dependencies['@base-ui/react']).toBeUndefined()
    expect(nextManifest.dependencies['@caldera/inertia']).toBeUndefined()
    expect(readFileSync(join(next.directory, 'AGENTS.md'), 'utf8')).not.toContain('coss ui')
  })

  it('makes the starter kit: Better Auth wired in, auth and settings pages, layouts, and tests', async () => {
    const { directory: dir } = await createProject({ directory: join(base, 'starter-kit'), ...offline })
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    for (const file of ['src/auth.ts', 'src/middleware.ts', 'src/routes/auth.ts', 'src/routes/settings.ts', 'src/db/auth-schema.ts', 'resources/pages/auth/Login.tsx', 'resources/pages/settings/Profile.tsx', 'resources/layouts/app/app-header-layout.tsx', 'resources/layouts/auth/auth-split-layout.tsx', 'resources/components/ui/sidebar.tsx', 'tests/auth/authentication.test.ts', 'resources/pages/auth/TwoFactorChallenge.tsx', 'resources/components/passkeys.tsx', 'tests/settings/two-factor.test.ts']) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
    expect(read('src/app.ts')).toMatch(/import \{ auth \} from '\.\/auth'[\s\S]*providers: \[\n[^\n]*\n    auth,/)
    // Every policy in src/policies applies: codegen lists them, and the gate registers the list.
    expect(read('src/app.ts')).toContain("import { policies } from '../.caldera/policies.gen'")
    expect(read('src/app.ts')).toContain('    authorizationProvider({ policies }),\n')
    expect(read('src/auth.ts')).toContain("provider: 'sqlite'")
    // Two-factor and passkeys are on, and their tables are in the schema.
    expect(read('src/auth.ts')).toMatch(/twoFactor\(\{[\s\S]*passkey\(\{/)
    expect(read('src/db/auth-schema.ts')).toMatch(/snakeCase\.table\('twoFactor'[\s\S]*snakeCase\.table\('passkey'/)
    expect(read('src/config/auth.ts')).toMatch(/twoFactor: true,[\s\S]*passkeys: true,/)
    expect(read('src/db/schema.ts')).toContain("from '@caldera/auth/sqlite'")
    expect(read('AGENTS.md')).toContain('Auth (the starter kit)')
    // No public list of users (the blank kit's /users route) once there are accounts.
    expect(read('src/routes/home.ts')).not.toContain('/users')
    expect(JSON.parse(read('package.json')).dependencies).toMatchObject({ 'better-auth': expect.any(String), '@caldera/auth': expect.any(String), '@base-ui/react': expect.any(String) })
    // The blank kit has none of it.
    const blank = await createProject({ directory: join(base, 'blank-kit'), ...offline, kit: 'blank' })
    expect(existsSync(join(blank.directory, 'src/auth.ts'))).toBe(false)
    expect(readFileSync(join(blank.directory, 'src/app.ts'), 'utf8')).not.toContain("from './auth'")
    expect(readFileSync(join(blank.directory, 'AGENTS.md'), 'utf8')).not.toContain('Auth (the starter kit)')
  })

  it('adds teams to the starter kit: the organization plugin, g.org, the switcher and team settings', async () => {
    const result = await createProject({ directory: join(base, 'teams'), ...offline, teams: true })
    const read = (file: string) => readFileSync(join(result.directory, file), 'utf8')
    expect(result.teams).toBe(true)
    for (const file of ['src/teams.ts', 'src/roles.ts', 'src/routes/teams.ts', 'resources/components/team-switcher.tsx', 'resources/pages/settings/Team.tsx', 'tests/teams/teams.test.ts']) expect(existsSync(join(result.directory, file)), file).toBe(true)
    expect(read('src/auth.ts')).toMatch(/databaseHooks: teamHooks\(db\)[\s\S]*plugins: \[\n[^\n]*\n        teamsPlugin\(/)
    expect(read('src/app.ts')).toContain('authorizationProvider({ policies, extend: organizationGate({ roles }) })')
    expect(read('src/app.ts').match(/authorizationProvider\(/g)).toHaveLength(1)
    expect(read('src/inertia.ts')).toContain('teams: () => teamsFor(c)')
    expect(read('resources/components/app-sidebar.tsx')).toContain('<TeamSwitcher />')
    expect(read('resources/components/app-sidebar.tsx')).not.toContain('AppLogo')
    // The header layout has one too, next to the logo.
    expect(read('resources/components/app-header.tsx')).toContain('<AppLogo />\n        </Link>\n        <HeaderTeamSwitcher />\n')
    expect(read('resources/components/navigation.ts')).toContain("{ title: 'Teams', href: '/settings/teams' }")
    // The command menu (⌘K) lists the teams to switch to.
    expect(read('resources/components/command-menu.tsx')).toMatch(/const teams = useTeamCommands\(\)[\s\S]*\{ value: 'Pages', .*\n.*\n    teams,\n/)
    expect(read('src/db/auth-schema.ts')).toContain("snakeCase.table('organization'")
    expect(read('AGENTS.md')).toContain('Teams (Better Auth organizations')
    // On Postgres, the Postgres tables.
    const pg = await createProject({ directory: join(base, 'teams-pg'), ...offline, teams: true, database: 'postgres' })
    expect(readFileSync(join(pg.directory, 'src/db/auth-schema.ts'), 'utf8')).toMatch(/from 'drizzle-orm\/pg-core'[\s\S]*snakeCase\.table\('organization'/)
    expect(readFileSync(join(pg.directory, 'src/db/schema.ts'), 'utf8')).toContain('organization, member, invitation } = authSchema(users)')
    // Without --teams, none of it.
    const plain = await createProject({ directory: join(base, 'no-teams'), ...offline })
    expect(plain.teams).toBe(false)
    expect(existsSync(join(plain.directory, 'src/teams.ts'))).toBe(false)
  })

  it('ships browser tests (Playwright) and a CI workflow for the app’s package manager and database', async () => {
    const { directory: dir } = await createProject({ directory: join(base, 'browser'), ...offline, packageManager: 'pnpm', teams: true })
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    for (const file of ['playwright.config.ts', 'tests/browser/server.ts', 'tests/browser/appearance.spec.ts', 'tests/browser/auth.spec.ts', 'tests/browser/security.spec.ts', 'tests/browser/teams.spec.ts', 'tests/totp.ts']) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
    const manifest = JSON.parse(read('package.json'))
    expect(manifest.scripts['test:browser']).toBe('playwright test')
    expect(manifest.devDependencies['@playwright/test']).toBeDefined()
    expect(read('playwright.config.ts')).toContain("command: 'pnpm build && node --import tsx tests/browser/server.ts'")
    // Vitest leaves Playwright's files alone.
    expect(read('vitest.config.ts')).toContain("'tests/browser/**'")
    expect(read('.gitignore')).toContain('playwright-report/')
    expect(read('AGENTS.md')).toContain('Browser tests (`pnpm test:browser`')
    expect(read('README.md')).toContain('pnpm test:browser  # browser tests')
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('- uses: pnpm/action-setup@v4')
    expect(ci).toContain('- run: pnpm install --frozen-lockfile')
    expect(ci).toMatch(/run: pnpm typecheck\n.*run: pnpm test\n.*playwright install --with-deps chromium\n.*run: pnpm test:browser/)
    expect(ci).not.toContain('postgres')

    // npm on Postgres: npm's commands, and a Postgres service whose database the tests reset.
    const pg = await createProject({ directory: join(base, 'browser-pg'), ...offline, packageManager: 'npm', kit: 'blank', database: 'postgres' })
    const pgCi = readFileSync(join(pg.directory, '.github/workflows/ci.yml'), 'utf8')
    expect(pgCi).toContain('- run: npm ci')
    expect(pgCi).toContain('- run: npm run test:browser')
    expect(pgCi).toContain('cache: npm')
    expect(pgCi).not.toContain('pnpm')
    expect(pgCi).toMatch(/image: postgres:17[\s\S]*POSTGRES_DB: browser_pg_test[\s\S]*DATABASE_TEST_URL: postgres:\/\/postgres:postgres@localhost:5432\/browser_pg_test/)
    // Both test runners reset that database: Vitest one file at a time, and still without Playwright's files.
    expect(readFileSync(join(pg.directory, 'vitest.config.ts'), 'utf8')).toContain("test: { fileParallelism: false, exclude: [...configDefaults.exclude, 'tests/browser/**'] }")
    // Bun: `bun run test`, since `bun test` is Bun's own test runner.
    const bun = await createProject({ directory: join(base, 'browser-bun'), ...offline, packageManager: 'bun' })
    const bunCi = readFileSync(join(bun.directory, '.github/workflows/ci.yml'), 'utf8')
    expect(bunCi).toMatch(/- uses: oven-sh\/setup-bun@v2[\s\S]*- run: bun run test\n[\s\S]*- run: bun run test:browser/)
    expect(readFileSync(join(bun.directory, 'README.md'), 'utf8')).toContain('bun run test ')
    expect(bun.next.at(-1)).toBe('bun run dev')
    // Yarn 2+ comes from corepack, not the runner's global Yarn 1.
    const yarn = await createProject({ directory: join(base, 'browser-yarn'), ...offline, packageManager: 'yarn' })
    const yarnCi = readFileSync(join(yarn.directory, '.github/workflows/ci.yml'), 'utf8')
    expect(yarnCi).toMatch(/node-version: 24\n      - run: corepack enable\n      - run: yarn install/)
    expect(yarnCi).not.toContain('cache: yarn')
    expect(ci).toContain('branches: [main, master]')

    // Next.js apps have no browser tests or workflow yet.
    const next = await createProject({ directory: join(base, 'browser-next'), ...offline, frontend: 'next' })
    expect(existsSync(join(next.directory, 'playwright.config.ts'))).toBe(false)
    expect(existsSync(join(next.directory, '.github'))).toBe(false)
  })

  it('gives a starter app on Postgres the Postgres auth tables and adapter', async () => {
    const { directory: dir } = await createProject({ directory: join(base, 'starter-pg'), ...offline, database: 'postgres' })
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    expect(read('src/auth.ts')).toContain("provider: 'pg'")
    expect(read('src/db/schema.ts')).toContain("from '@caldera/auth'\n")
    expect(read('src/db/auth-schema.ts')).toContain("from 'drizzle-orm/pg-core'")
    expect(read('src/app.ts')).toContain("from 'drizzle-orm/node-postgres'")
    // Test files share the one test database: run one at a time (also in the Next.js variant's own config).
    expect(read('vitest.config.ts')).toContain('fileParallelism: false')
    const next = await createProject({ directory: join(base, 'next-pg-tests'), ...offline, frontend: 'next', database: 'postgres' })
    expect(readFileSync(join(next.directory, 'vitest.config.ts'), 'utf8')).toMatch(/test: \{ fileParallelism: false \}, oxc/)
  })

  it('keeps Caldera’s own tables in step with `caldera queue:table` and friends, for both dialects', () => {
    const tables = { 'caldera-jobs': 'queue-table', 'caldera-cache': 'cache-table', 'caldera-notifications': 'notifications-table' } as const
    for (const [file, stub] of Object.entries(tables)) {
      expect(readFileSync(join(import.meta.dirname, `../template/src/db/tables/${file}.ts`), 'utf8'), file).toBe(STUBS[`${stub}-sqlite`])
      expect(readFileSync(join(import.meta.dirname, `../databases/postgres/src/db/tables/${file}.ts`), 'utf8'), file).toBe(STUBS[stub])
    }
  })

  it('makes a Postgres app: node-postgres, pg tables, a test database, and migrations left to you', async () => {
    const result = await createProject({ directory: join(base, 'Shop App'), ...offline, packageManager: 'pnpm', database: 'postgres' })
    const dir = result.directory
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    expect(result.database).toBe('postgres')
    expect(read('src/app.ts')).toContain("import { drizzle } from 'drizzle-orm/node-postgres'")
    expect(read('src/app.ts')).toContain("driver: 'postgres'")
    expect(read('src/app.ts')).not.toMatch(/libsql|d1/)
    expect(read('src/db/schema.ts')).toContain("from 'drizzle-orm/pg-core'")
    expect(read('src/db/tables/caldera-jobs.ts')).toContain('pgTable')
    expect(read('drizzle.config.ts')).toContain("dialect: 'postgresql'")
    expect(read('src/env.ts')).toContain("DATABASE_URL: z.string().default('postgres://localhost:5432/shop_app')")
    expect(read('src/env.ts')).not.toContain('DATABASE_AUTH_TOKEN')
    expect(read('src/config/database.ts')).not.toContain('authToken')
    expect(read('.env')).toContain('DATABASE_TEST_URL=postgres://localhost:5432/shop_app_test')
    expect(read('README.md')).toContain('(Postgres: shop_app)')
    const manifest = JSON.parse(read('package.json'))
    expect(manifest.dependencies.pg).toBeDefined()
    expect(manifest.devDependencies['@types/pg']).toBeDefined()
    expect(manifest.dependencies['@libsql/client']).toBeUndefined()
    expect(result.next).toEqual([`cd ${dir}`, 'pnpm install', 'pnpm exec caldera generate', 'pnpm exec caldera db:generate -- --name init', 'createdb shop_app && createdb shop_app_test', 'pnpm exec caldera db:migrate', 'pnpm dev'])
    // The Next.js variant shares the base, so it gets Postgres the same way.
    const next = await createProject({ directory: join(base, 'next-pg'), ...offline, frontend: 'next', database: 'postgres' })
    expect(readFileSync(join(next.directory, 'src/app.ts'), 'utf8')).toContain("from 'drizzle-orm/node-postgres'")
  })

  it('sets up a deploy target with its own command, its dependencies already in package.json', async () => {
    const vercel = await createProject({ directory: join(base, 'v'), ...offline, packageManager: 'pnpm', target: 'vercel' })
    expect(vercel.steps.find((s) => s.name === 'target')).toEqual({ name: 'target', status: 'skipped', command: 'pnpm exec caldera vercel:setup' })
    expect(vercel.next).toContain('pnpm exec caldera vercel:setup')
    expect(JSON.parse(readFileSync(join(vercel.directory, 'package.json'), 'utf8')).dependencies['@vercel/functions']).toBeDefined()
    const workers = await createProject({ directory: join(base, 'w'), ...offline, packageManager: 'pnpm', target: 'cloudflare' })
    expect(JSON.parse(readFileSync(join(workers.directory, 'package.json'), 'utf8')).devDependencies.wrangler).toBe('4.151.0')
    expect(readFileSync(join(workers.directory, '.gitignore'), 'utf8')).toContain('.dev.vars')
    // With the setup step left for later too: `wrangler dev` gets the APP_KEY from .env.
    expect(readFileSync(join(workers.directory, '.dev.vars'), 'utf8')).toBe(`${readFileSync(join(workers.directory, '.env'), 'utf8').match(/^APP_KEY=.*$/m)![0]}\n`)
    // Vercel builds Next.js apps itself: nothing to set up.
    const next = await createProject({ directory: join(base, 'nv'), ...offline, frontend: 'next', target: 'vercel' })
    expect(next.steps.map((s) => s.name)).not.toContain('target')
  })

  it('refuses combinations that can’t work, before writing anything', async () => {
    await expect(createProject({ directory: join(base, 'a'), ...offline, database: 'postgres', target: 'cloudflare' })).rejects.toThrow(expect.objectContaining({ code: 'unsupported', message: expect.stringContaining('D1') }))
    await expect(createProject({ directory: join(base, 'b'), ...offline, frontend: 'next', target: 'cloudflare' })).rejects.toThrow(expect.objectContaining({ code: 'unsupported' }))
    await expect(createProject({ directory: join(base, 'c'), ...offline, kit: 'blank', teams: true })).rejects.toThrow(expect.objectContaining({ code: 'unsupported', message: expect.stringContaining('starter kit') }))
    expect(existsSync(join(base, 'a'))).toBe(false)
  })

  it('never touches a non-empty folder, and suggests a free name', async () => {
    const dir = join(base, 'taken')
    mkdirSync(dir)
    writeFileSync(join(dir, 'keep.txt'), 'mine')
    await expect(createProject({ directory: dir, ...offline })).rejects.toThrow(expect.objectContaining({ code: 'dir_not_empty', details: expect.objectContaining({ suggestion: 'taken-2' }) }))
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine')
    mkdirSync(join(base, 'empty'))
    await expect(createProject({ directory: join(base, 'empty'), ...offline })).resolves.toBeDefined()
  })

  it('reports skipped steps with the exact commands to finish setup, and exits successfully', async () => {
    const result = await createProject({ directory: join(base, 'app'), ...offline, packageManager: 'npm' })
    expect(result.steps.map((s) => [s.name, s.status])).toEqual([
      ['files', 'done'],
      ['install', 'skipped'],
      ['generate', 'skipped'],
      ['database', 'skipped'],
      ['git', 'skipped'],
    ])
    expect(result.next).toEqual([`cd ${join(base, 'app')}`, 'npm install', 'npm exec -- caldera generate', 'npm exec -- caldera db:generate -- --name init && npm exec -- caldera db:migrate', 'npm run dev'])
  })

  it('records the package manager version only when the package manager reported it', async () => {
    const withAgent = await createProject({ directory: join(base, 'a'), ...offline, env: { PATH: '', npm_config_user_agent: 'pnpm/11.25.0 npm/? node/v24.14.1 darwin arm64' } })
    expect(JSON.parse(readFileSync(join(withAgent.directory, 'package.json'), 'utf8')).packageManager).toBe('pnpm@11.25.0')
    const without = await createProject({ directory: join(base, 'b'), ...offline, packageManager: 'pnpm' })
    expect(JSON.parse(readFileSync(join(without.directory, 'package.json'), 'utf8'))).not.toHaveProperty('packageManager')
  })

  it('installs @caldera packages from local tarballs in development, as npm would', async () => {
    const result = await createProject({ directory: join(base, 'linked'), ...offline, packageManager: 'pnpm', link: repo })
    const manifest = JSON.parse(readFileSync(join(result.directory, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@caldera/core']).toMatch(/^file:\.\/\.caldera-local\/caldera-core-.+\.tgz$/)
    expect(manifest.devDependencies['@caldera/cli']).toMatch(/^file:\.\/\.caldera-local\/caldera-cli-/)
    expect(readFileSync(join(result.directory, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/overrides:\n(  '@caldera\/\w+': 'file:.+'\n){12}/)
    expect(readFileSync(join(result.directory, '.gitignore'), 'utf8')).toContain('.caldera-local')
    expect(manifest.dependencies.hono).toMatch(/^\^/)
  }, 60_000)
})

describe('detectPackageManager', () => {
  it('prefers the user agent, then what is installed, then npm', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'yarn/4.5.0 npm/? node/v24' })).toBe('yarn')
    const bin = mkdtempSync(join(tmpdir(), 'pm-bin-'))
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\n')
    chmodSync(join(bin, 'bun'), 0o755)
    expect(detectPackageManager({ PATH: bin })).toBe('bun')
    expect(detectPackageManager({ PATH: '' })).toBe('npm')
    expect(packageManagerVersion('pnpm', { npm_config_user_agent: 'pnpm/11.25.0 npm/?' })).toBe('11.25.0')
    expect(packageManagerVersion('pnpm', {})).toBeUndefined()
    rmSync(bin, { recursive: true, force: true })
  })
})

// End to end against the npm registry: CALDERA_E2E=1 pnpm vitest run packages/create-caldera
describe.runIf(process.env.CALDERA_E2E === '1')('end to end', () => {
  it('creates, installs, generates, type-checks, tests and serves a working app', async () => {
    const result = await createProject({ directory: join(base, 'e2e-app'), packageManager: 'pnpm', link: repo, git: true })
    const dir = result.directory
    expect(result.steps.filter((s) => s.status !== 'done'), readFileSync(result.log, 'utf8').slice(-3000)).toEqual([])

    const run = (...args: string[]) => spawnSync('pnpm', args, { cwd: dir, encoding: 'utf8' })
    const typecheck = run('typecheck')
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0)
    const tests = run('test')
    expect(tests.status, tests.stdout + tests.stderr).toBe(0)
    // The starter's auth tables are what `caldera auth:schema` generates from its Better Auth config.
    const schema = run('exec', 'caldera', 'auth:schema', '--check', '--json')
    expect(JSON.parse(schema.stdout).status, schema.stdout + schema.stderr).toBe('unchanged')
    // Sign-up, two-factor and passkeys (Chrome's virtual authenticator), light/dark and ⌘K, in Chromium.
    expect(runsBrowserTests(dir)).toMatch(/\b10 passed\b/)

    const { spawn } = await import('node:child_process')
    const poll = async <T>(read: () => Promise<T | undefined>): Promise<T | undefined> => {
      for (let i = 0; i < 60; i++) {
        const value = await read().catch(() => undefined)
        if (value !== undefined) return value
        await new Promise((r) => setTimeout(r, 500))
      }
      return undefined
    }

    // `caldera dev`: the codegen watcher, the server under tsx watch, and Vite.
    const dev = spawn('pnpm', ['dev'], { cwd: dir, env: { ...process.env, PORT: '3456', APP_URL: 'http://localhost:3456' }, detached: true })
    try {
      // The database step created the tables: registering works.
      await poll(() => fetch('http://localhost:3456/login').then((r) => (r.ok ? true : undefined)))
      await registersAndSignsIn('http://localhost:3456')
      // The page loads its scripts from the Vite dev server, which compiles the entry.
      const html = await poll(() => fetch('http://localhost:3456/').then((r) => r.text()).then((t) => (t.includes('@vite/client') ? t : undefined)))
      // With the CSP nonce, so the strict CSP lets the dev server's scripts run.
      expect(html).toMatch(/<script type="module" src="http:\/\/localhost:5173\/resources\/app\.tsx" nonce="[\w+/=]+"><\/script>/)
      expect(html).toContain('"component":"Home"')
      const entry = await fetch('http://localhost:5173/resources/app.tsx').then((r) => r.text())
      expect(entry).toContain('createInertiaApp')
    } finally {
      process.kill(-dev.pid!, 'SIGTERM') // the whole group: pnpm, caldera dev, tsx and vite
    }
    await poll(async () => (existsSync(join(dir, '.caldera/vite.hot')) ? undefined : true))
    expect(existsSync(join(dir, '.caldera/vite.hot'))).toBe(false)

    // Production: built assets from the manifest, served from public/build.
    const build = run('build')
    expect(build.status, build.stdout + build.stderr).toBe(0)
    // As in production: without this test runner's VITEST variables, which mark a test run.
    const productionEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))
    const start = spawn('pnpm', ['start'], { cwd: dir, env: { ...productionEnv, PORT: '3457', NODE_ENV: 'production' }, detached: true })
    let serverOutput = ''
    start.stdout?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()))
    start.stderr?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()))
    try {
      const html = await poll(() => fetch('http://localhost:3457/').then((r) => r.text()))
      const script = /<script type="module" src="(\/build\/assets\/[^"]+\.js)" nonce="[\w+/=]+">/.exec(html ?? '')?.[1]
      expect(script, html).toBeDefined()
      expect(html).toMatch(/<link rel="stylesheet" href="\/build\/assets\/[^"]+\.css" nonce="[\w+/=]+">/)
      const asset = await fetch(`http://localhost:3457${script}`)
      expect(asset.status).toBe(200)
      // Server-side rendered from build/ssr/ssr.js, in-process: the content is in the HTML.
      expect(html, serverOutput).toContain('<div data-server-rendered="true" id="app"><div')
      expect(html).toContain('Let’s get started')
      // Light/dark: the system theme is resolved by an inline script (with the nonce) before the first paint.
      expect(html).toMatch(/<script nonce="[\w+/=]+">\(function\(\)\{var d=window\.matchMedia/)
      const dark = await fetch('http://localhost:3457/', { headers: { cookie: 'appearance=dark' } }).then((r) => r.text())
      expect(dark).toContain('<html lang="en" class="dark" style="color-scheme: dark">')
      expect(html).toContain('<title data-inertia="">Welcome · e2e-app</title>')
      // A visit with the old asset version is told to reload the page.
      const stale = await fetch('http://localhost:3457/', { headers: { 'x-inertia': 'true', 'x-inertia-version': 'old' } })
      expect(stale.status).toBe(409)
    } finally {
      process.kill(-start.pid!, 'SIGTERM')
    }
  }, 300_000)
  it.each([
    { name: 'the blank kit', options: { kit: 'blank' as const }, browserTests: 3 },
    { name: 'the starter kit with teams', options: { teams: true }, browserTests: 13 },
  ])('creates $name on SQLite: it type-checks and passes its tests and browser tests', async ({ options, browserTests }) => {
    const result = await createProject({ directory: join(base, 'e2e-kit'), packageManager: 'pnpm', link: repo, git: false, ...options })
    const dir = result.directory
    expect(result.steps.filter((s) => s.status !== 'done' && s.name !== 'git'), readFileSync(result.log, 'utf8').slice(-3000)).toEqual([])
    const run = (...args: string[]) => spawnSync('pnpm', args, { cwd: dir, encoding: 'utf8' })
    const ok = (r: ReturnType<typeof run>) => expect(r.status, r.stdout + r.stderr).toBe(0)
    ok(run('typecheck'))
    ok(run('test'))
    expect(runsBrowserTests(dir)).toMatch(new RegExp(`\\b${browserTests} passed\\b`))
  }, 300_000)
  it('creates a Next.js app that type-checks, tests, builds and serves pages and the API', async () => {
    const result = await createProject({ directory: join(base, 'e2e-next'), packageManager: 'pnpm', link: repo, git: false, frontend: 'next' })
    const dir = result.directory
    expect(result.steps.filter((s) => s.status !== 'done' && s.name !== 'git'), readFileSync(result.log, 'utf8').slice(-3000)).toEqual([])
    const run = (...args: string[]) => spawnSync('pnpm', args, { cwd: dir, encoding: 'utf8' })
    const typecheck = run('typecheck')
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0)
    const tests = run('test')
    expect(tests.status, tests.stdout + tests.stderr).toBe(0)
    const { spawn } = await import('node:child_process')
    const poll = async <T>(read: () => Promise<T | undefined>): Promise<T | undefined> => {
      for (let i = 0; i < 120; i++) {
        const value = await read().catch(() => undefined)
        if (value !== undefined) return value
        await new Promise((r) => setTimeout(r, 500))
      }
      return undefined
    }

    // `caldera dev` runs `next dev`: pages and the API, with the error log for `caldera mcp`.
    const dev = spawn('pnpm', ['dev'], { cwd: dir, env: { ...process.env, PORT: '3458' }, detached: true })
    try {
      expect(await poll(() => fetch('http://localhost:3458/api/hello').then((r) => r.json()))).toEqual({ message: 'Your app is running.' })
      const html = await poll(() => fetch('http://localhost:3458/').then((r) => (r.ok ? r.text() : undefined)))
      expect(html).toContain('<h1>Welcome</h1>')
      expect(existsSync(join(dir, '.caldera/dev-errors.jsonl'))).toBe(true)
    } finally {
      process.kill(-dev.pid!, 'SIGTERM')
    }

    const build = run('build')
    expect(build.status, build.stdout + build.stderr).toBe(0)
    const start = spawn('pnpm', ['start'], { cwd: dir, env: { ...process.env, PORT: '3459' }, detached: true })
    try {
      // The API first, so the page renders after another copy of the app has booted (Next bundles them apart).
      expect(await poll(() => fetch('http://localhost:3459/api/users').then((r) => r.json()))).toEqual({ users: [] })
      const html = await poll(() => fetch('http://localhost:3459/', { headers: { 'accept-language': 'en' } }).then((r) => (r.ok ? r.text() : undefined)))
      expect(html).toContain('No users yet')
      expect(html).toContain('<html lang="en">')
      // /_caldera/* is rewritten to the API: an unsigned file link is refused there.
      expect((await fetch('http://localhost:3459/_caldera/storage/local/x.txt')).status).toBe(403)
      expect((await fetch('http://localhost:3459/api/nope').then((r) => r.json())).error.code).toBe('not_found')
    } finally {
      process.kill(-start.pid!, 'SIGTERM')
    }
  }, 600_000)
  it('runs on Cloudflare Workers (--target cloudflare): D1, the database cache, R2 and assets under wrangler dev', async () => {
    const result = await createProject({ directory: join(base, 'e2e-workers'), packageManager: 'pnpm', link: repo, git: false, target: 'cloudflare' })
    const dir = result.directory
    expect(result.steps.filter((s) => s.status !== 'done' && s.name !== 'git'), readFileSync(result.log, 'utf8').slice(-3000)).toEqual([])
    expect(existsSync(join(dir, 'wrangler.json'))).toBe(true)
    expect(readFileSync(join(dir, '.dev.vars'), 'utf8')).toMatch(/^APP_KEY=[\w-]{43}\n$/)
    const run = (command: string, ...args: string[]) => spawnSync(command, args, { cwd: dir, encoding: 'utf8' })
    const ok = (r: ReturnType<typeof run>) => expect(r.status, r.stdout + r.stderr).toBe(0)
    // A route using each Workers service, as an app would.
    writeFileSync(
      join(dir, 'src/routes/edge.ts'),
      `import { defineRoutes } from '@caldera/http'\nimport { User } from '../models/user.js'\n\nexport const edge = defineRoutes('edge', { prefix: '/edge' })\n  .get('users', '/users', async (c) => c.json({ users: await User.findMany(), cache: c.var.cache.name, hits: await c.var.cache.increment('hits') }))\n  .get('file', '/file', async (c) => {\n    const disk = c.var.storage.disk(c.var.storage.name as 'r2')\n    await disk.put('hi.txt', 'hi from r2')\n    return c.json({ disk: disk.name, text: await disk.getText('hi.txt') })\n  })\n`,
    )
    ok(run('pnpm', 'exec', 'caldera', 'generate'))
    ok(run('pnpm', 'typecheck'))
    ok(run('pnpm', 'exec', 'caldera', 'db:generate'))
    ok(run('pnpm', 'exec', 'caldera', 'd1:migrations'))
    ok(run('pnpm', 'exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'))
    ok(run('pnpm', 'build'))
    const check = run('pnpm', 'exec', 'caldera', 'check', '--json')
    expect(JSON.parse(check.stdout).issues.filter((i: { code: string }) => i.code.startsWith('workers_'))).toEqual([])

    const { spawn } = await import('node:child_process')
    const poll = async <T>(read: () => Promise<T | undefined>): Promise<T | undefined> => {
      for (let i = 0; i < 120; i++) {
        const value = await read().catch(() => undefined)
        if (value !== undefined) return value
        await new Promise((r) => setTimeout(r, 500))
      }
      return undefined
    }
    // Browsers reach it at localhost (WebAuthn needs a host name, not an IP): passkeys and Better Auth's
    // origin checks use APP_URL.
    writeFileSync(join(dir, '.dev.vars'), `${readFileSync(join(dir, '.dev.vars'), 'utf8')}APP_URL=http://localhost:3462\n`)
    writeFileSync(
      join(dir, 'playwright.workers.config.ts'),
      `import { defineConfig, devices } from '@playwright/test'\n\nexport default defineConfig({ testDir: 'tests/browser', testMatch: 'security.spec.ts', workers: 1, use: { baseURL: 'http://localhost:3462' }, projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }] })\n`,
    )
    const dev = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', '3462', '--ip', '127.0.0.1'], { cwd: dir, detached: true })
    try {
      expect(await poll(() => fetch('http://127.0.0.1:3462/edge/users').then((r) => r.json()))).toEqual({ users: [], cache: 'database', hits: 1 })
      expect(await fetch('http://127.0.0.1:3462/edge/file').then((r) => r.json())).toEqual({ disk: 'r2', text: 'hi from r2' })
      const html = await fetch('http://127.0.0.1:3462/').then((r) => r.text())
      const script = /<script type="module" src="(\/build\/assets\/[^"]+\.js)"/.exec(html)?.[1]
      expect(script, html.slice(0, 500)).toBeDefined()
      expect((await fetch(`http://127.0.0.1:3462${script}`)).status).toBe(200)
      // The SSR build is bundled into the Worker: rendered on workerd.
      expect(html).toContain('<div data-server-rendered="true" id="app"><div')
      expect(html).toContain('Let’s get started')
      // Realtime: the page points browsers at this origin, where the BroadcastHub Durable Object answers.
      expect(html).toMatch(/(?:"|&quot;)wsHost(?:"|&quot;):(?:"|&quot;)127\.0\.0\.1/)
      const socket = new WebSocket('ws://127.0.0.1:3462/app/e2e-workers-key?protocol=7')
      const hello = await new Promise<string>((resolve, reject) => {
        socket.onmessage = (event) => resolve(String(event.data))
        socket.onerror = () => reject(new Error('no WebSocket'))
      })
      socket.close()
      expect(JSON.parse(hello)).toMatchObject({ event: 'pusher:connection_established' })

      // The app's own browser tests for passkeys and two-factor, against workerd: a WebAuthn ceremony,
      // and the passkey counting as a password confirmation (Better Auth's hook reaches the request).
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))
      ok(spawnSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], { cwd: dir, encoding: 'utf8', env }))
      const browser = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.workers.config.ts'], { cwd: dir, encoding: 'utf8', env })
      expect(browser.status, browser.stdout + browser.stderr).toBe(0)
      expect(browser.stdout).toMatch(/\b2 passed\b/)
    } finally {
      process.kill(-dev.pid!, 'SIGTERM')
    }
  }, 600_000)
  it.runIf(spawnSync('turso', ['--version']).status === 0)('deploys to Vercel (--target vercel): vercel build, then pages, assets, a remote libSQL database and deferred jobs', async () => {
    // The blank kit (it keeps the /users route this uses).
    const result = await createProject({ directory: join(base, 'e2e-vercel'), packageManager: 'pnpm', link: repo, git: false, target: 'vercel', kit: 'blank' })
    const dir = result.directory
    expect(result.steps.filter((s) => s.status !== 'done' && s.name !== 'git'), readFileSync(result.log, 'utf8').slice(-3000)).toEqual([])
    const run = (command: string, ...args: string[]) => spawnSync(command, args, { cwd: dir, encoding: 'utf8' })
    const ok = (r: ReturnType<typeof run>) => expect(r.status, r.stdout + r.stderr).toBe(0)
    writeFileSync(
      join(dir, 'src/routes/signup.ts'),
      `import { defineRoutes } from '@caldera/http'\nimport { inbox, notify } from '@caldera/notifications'\nimport { User } from '../models/user.js'\nimport { Welcome } from '../notifications/welcome.js'\n\nexport const signup = defineRoutes('signup')\n  .post('store', '/signup', async (c) => {\n    const user = await User.create(await c.req.json())\n    await notify(user, Welcome, { name: user.name, url: 'https://example.test' })\n    return c.json({ id: user.id })\n  })\n  .get('inbox', '/inbox/:id', async (c) => c.json(await inbox(await User.findOrFail(c.req.param('id'))).list()))\n`,
    )
    ok(run('pnpm', 'exec', 'caldera', 'generate'))
    ok(run('pnpm', 'typecheck'))
    // As Vercel gets it from git: nothing generated or built yet.
    rmSync(join(dir, '.caldera'), { recursive: true, force: true })
    mkdirSync(join(dir, '.vercel'), { recursive: true })
    writeFileSync(join(dir, '.vercel/project.json'), JSON.stringify({ projectId: 'prj_e2e', orgId: 'team_e2e', settings: { framework: null, nodeVersion: '22.x' } }))
    ok(run('npx', '-y', 'vercel@64.3.1', 'build', '--yes'))

    const { spawn } = await import('node:child_process')
    const turso = spawn('turso', ['dev', '--db-file', join(dir, 'local.db'), '--port', '3463'], { detached: true })
    const saved = { ...process.env }
    Object.assign(process.env, { APP_KEY: 'k'.repeat(43), DATABASE_URL: 'http://127.0.0.1:3463', QUEUE_CONNECTION: 'deferred', NODE_ENV: 'production' })
    const { serveVercelOutput } = await import('./vercel-runtime.js')
    const site = await serveVercelOutput(dir, 3464)
    try {
      const B = 'http://127.0.0.1:3464'
      for (let i = 0; i < 40 && !(await fetch('http://127.0.0.1:3463/health').then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 250))
      expect(await fetch(`${B}/users`).then((r) => r.json())).toEqual({ users: [] })
      const html = await fetch(`${B}/`).then((r) => r.text())
      const script = /<script type="module" src="(\/build\/assets\/[^"]+\.js)"/.exec(html)?.[1]
      expect(script, html.slice(0, 400)).toBeDefined()
      expect((await fetch(`${B}${script}`)).status).toBe(200)
      const signup = await fetch(`${B}/signup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3464' }, body: JSON.stringify({ name: 'Vee', email: 'vee@example.test' }) })
      const { id } = (await signup.json()) as { id: string }
      // Deferred: the notification's jobs run after the response.
      let notifications: unknown[] = []
      for (let i = 0; i < 40 && notifications.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100))
        notifications = (await fetch(`${B}/inbox/${id}`).then((r) => r.json())) as unknown[]
      }
      expect(notifications).toMatchObject([{ type: 'users.welcome' }])
    } finally {
      await site.stop()
      process.env = saved
      process.kill(-turso.pid!, 'SIGTERM')
    }
  }, 600_000)
  it.runIf(hasPostgres)('creates Postgres apps that migrate, type-check, test and browser-test (DATABASE_TEST_URL from .env) and serve', async () => {
    // With teams: the riskiest combination (the organization plugin's tables and hooks on Postgres).
    const result = await createProject({ directory: join(base, 'e2e-pg'), packageManager: 'pnpm', link: repo, git: false, database: 'postgres', teams: true })
    const dir = result.directory
    expect(result.steps.filter((s) => s.status !== 'done' && s.name !== 'git'), readFileSync(result.log, 'utf8').slice(-3000)).toEqual([])
    expect(readdirSync(join(dir, 'drizzle')).some((f) => f.endsWith('_init'))).toBe(true)
    const server = await startPostgres()
    const { spawn } = await import('node:child_process')
    try {
      // As the next steps say (createdb), against a throwaway server instead of localhost.
      for (const name of ['e2e_pg', 'e2e_pg_test']) expect(spawnSync('psql', [server.url, '-c', `create database ${name}`]).status).toBe(0)
      const env = readFileSync(join(dir, '.env'), 'utf8')
        .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${server.url.replace(/\/postgres$/, '/e2e_pg')}`)
        .replace(/^DATABASE_TEST_URL=.*$/m, `DATABASE_TEST_URL=${server.url.replace(/\/postgres$/, '/e2e_pg_test')}`)
      writeFileSync(join(dir, '.env'), env)
      const run = (...args: string[]) => spawnSync('pnpm', args, { cwd: dir, encoding: 'utf8' })
      const ok = (r: ReturnType<typeof run>) => expect(r.status, r.stdout + r.stderr).toBe(0)
      ok(run('exec', 'caldera', 'db:migrate'))
      ok(run('typecheck'))
      ok(run('test'))
      const schema = run('exec', 'caldera', 'auth:schema', '--check', '--json')
      expect(JSON.parse(schema.stdout), schema.stdout + schema.stderr).toMatchObject({ status: 'unchanged', dialect: 'pg' })
      // On DATABASE_TEST_URL, which the browser tests' server resets as Vitest does.
      expect(runsBrowserTests(dir)).toMatch(/\b13 passed\b/)
      const dev = spawn('pnpm', ['dev'], { cwd: dir, env: { ...process.env, PORT: '3465', APP_URL: 'http://localhost:3465' }, detached: true })
      try {
        for (let i = 0; i < 60 && !(await fetch('http://localhost:3465/login').then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 500))
        await registersAndSignsIn('http://localhost:3465')
      } finally {
        process.kill(-dev.pid!, 'SIGTERM')
      }

      // The blank kit on Postgres too.
      const blank = await createProject({ directory: join(base, 'e2e-pg-blank'), packageManager: 'pnpm', link: repo, git: false, database: 'postgres', kit: 'blank' })
      expect(blank.steps.filter((s) => s.status !== 'done' && s.name !== 'git'), readFileSync(blank.log, 'utf8').slice(-3000)).toEqual([])
      expect(spawnSync('psql', [server.url, '-c', 'create database e2e_pg_blank_test']).status).toBe(0)
      writeFileSync(join(blank.directory, '.env'), readFileSync(join(blank.directory, '.env'), 'utf8').replace(/^DATABASE_TEST_URL=.*$/m, `DATABASE_TEST_URL=${server.url.replace(/\/postgres$/, '/e2e_pg_blank_test')}`))
      const runBlank = (...args: string[]) => spawnSync('pnpm', args, { cwd: blank.directory, encoding: 'utf8' })
      ok(runBlank('typecheck'))
      ok(runBlank('test'))
      expect(runsBrowserTests(blank.directory)).toMatch(/\b3 passed\b/)
    } finally {
      await server.stop()
    }
  }, 600_000)
})
