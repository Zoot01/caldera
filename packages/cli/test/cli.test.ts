import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeProject, generate, listRoutes, openProject } from '../src/index.js'

const here = import.meta.dirname
const bin = join(here, '../bin/caldera.js')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
let root: string

// Each test gets a fresh copy inside test/.tmp so node_modules resolution still works.
beforeEach(() => {
  root = join(here, '.tmp', `app-${Math.random().toString(36).slice(2)}`)
  // Skip any .caldera/ generated in the fixture for editor support: tests start ungenerated.
  cpSync(join(here, 'fixtures/basic-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
afterAll(() => rmSync(join(here, '.tmp'), { recursive: true, force: true }))

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
      ['.caldera/.gitignore', 'created'],
    ])
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
      `import { defineConfig } from '@caldera/core'\nexport const mail = defineConfig('mail', () => ({ from: 'hi@example.test' }))\n`,
    )
    const check = await generate(project, { check: true })
    expect(check.stale).toBe(true)
    expect(check.files.find((f) => f.path.endsWith('config.gen.ts'))?.status).toBe('stale')
    expect(readFileSync(join(root, '.caldera/config.gen.ts'), 'utf8')).not.toContain('mail')
  })

  it('rejects two config files using the same name', async () => {
    writeFileSync(
      join(root, 'src/config/site-copy.ts'),
      `import { defineConfig } from '@caldera/core'\nexport const again = defineConfig('site', () => ({}))\n`,
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
    const { routes } = await listRoutes(openProject(root))
    expect(routes.map((r) => `${r.method} ${r.path} ${r.name}`)).toEqual(['GET /health health.check', 'GET /posts posts.index', 'GET /posts/:post posts.show'])
    const show = routes.find((r) => r.name === 'posts.show')!
    expect(show.params).toEqual(['post'])
    expect(show.source).toEqual({ file: 'src/routes/posts.ts', line: 8 })
    expect(show.input.params).toMatchObject({ type: 'object', required: ['post'] })
  })

  it('reports duplicate route names across files', async () => {
    writeFileSync(
      join(root, 'src/routes/copy.ts'),
      `import { defineRoutes } from '@caldera/http'\nexport const again = defineRoutes('health').get('check', '/other', (c) => c.text(''))\n`,
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
