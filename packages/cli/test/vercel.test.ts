import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { openProject, vercelBuild, vercelIssues, vercelSetup } from '../src/index.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'vercel-'
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})
const fresh = () => {
  const dir = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  return dir
}

it('vercel:setup writes vercel.json and the function, and refuses to overwrite them', () => {
  const dir = fresh()
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n')
  expect(vercelSetup(openProject(dir)).created).toEqual(['vercel.json', 'api/index.js'])
  expect(JSON.parse(readFileSync(join(dir, 'vercel.json'), 'utf8'))).toEqual({
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    buildCommand: 'caldera vercel:build && vite build',
    outputDirectory: 'public',
    functions: { 'api/index.js': { includeFiles: 'public/build/.vite/manifest.json' } },
    rewrites: [{ source: '/(.*)', destination: '/api' }],
  })
  expect(readFileSync(join(dir, 'api/index.js'), 'utf8')).toContain("export { default } from '../.caldera/vercel/function.mjs'")
  expect(() => vercelSetup(openProject(dir))).toThrow(/Refusing to overwrite vercel.json, api\/index.js/)
})

it('vercel:build compiles the app’s own code (TSX too), keeps packages external, and uses libSQL’s web client', async () => {
  const dir = fresh()
  mkdirSync(join(dir, 'src/mail'), { recursive: true })
  writeFileSync(join(dir, 'src/mail/hello.tsx'), 'export const Hello = () => <p>hi</p>\n')
  writeFileSync(
    join(dir, 'src/http.ts'),
    "import { drizzle } from 'drizzle-orm/libsql'\nimport { Hono } from 'hono'\nimport { Hello } from './mail/hello.js'\n\nexport const http = new Hono().get('/', (c) => c.json({ hello: typeof Hello, drizzle: typeof drizzle }))\n",
  )
  let generated = false
  const result = await vercelBuild(openProject(dir), async () => (generated = true))
  expect(generated).toBe(true)
  const bundle = readFileSync(join(dir, result.bundle), 'utf8')
  expect(bundle).toContain('from "drizzle-orm/libsql/web"')
  expect(bundle).toContain('from "hono"')
  expect(bundle).toContain('from "@vercel/functions"')
  expect(bundle).toMatch(/jsx\("p"/)
  expect(bundle).not.toContain('hello.js')
})

it('reports what can’t run on Vercel, from the pulled production env only', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'vercel.json'), '{}\n')
  const boot = async () => ({ config: {}, shutdown: async () => {} })
  expect((await vercelIssues(openProject(dir), boot)).map((i) => i.code)).toEqual(['vercel_env_unknown'])
  mkdirSync(join(dir, '.vercel'), { recursive: true })
  writeFileSync(join(dir, '.vercel/.env.production.local'), 'DATABASE_URL=file:local.db\nQUEUE_CONNECTION=database\n')
  let seen: { env: Record<string, unknown>; local?: boolean } | undefined
  const issues = await vercelIssues(openProject(dir), async (env, options) => {
    seen = { env, local: options?.local }
    return {
      config: {
        database: { url: env.DATABASE_URL },
        queue: { default: 'db', connections: { db: { driver: 'database' } } },
        storage: { default: 's3', disks: { s3: { driver: 's3' } } },
        cache: { default: 'memory', stores: { memory: { driver: 'memory' } } },
      },
      shutdown: async () => {},
    }
  })
  expect(seen).toMatchObject({ env: { DATABASE_URL: 'file:local.db', VERCEL: '1' }, local: false })
  expect(issues.map((i) => [i.code, i.severity])).toEqual([
    ['vercel_local_database', 'error'],
    ['vercel_queue', 'error'],
    ['vercel_memory_cache', 'warning'],
  ])
})

it('skips checks whose variables Vercel hides from vercel pull, and says so', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'vercel.json'), '{}\n')
  mkdirSync(join(dir, '.vercel'), { recursive: true })
  writeFileSync(join(dir, '.vercel/.env.production.local'), 'DATABASE_URL="[SENSITIVE]"\nQUEUE_CONNECTION="database"\n')
  let local: boolean | undefined
  const issues = await vercelIssues(openProject(dir), async (env, options) => {
    local = options?.local
    return {
      config: { database: { url: 'file:local.db' }, queue: { default: 'db', connections: { db: { driver: env.QUEUE_CONNECTION } } }, storage: {}, cache: {} },
      shutdown: async () => {},
    }
  })
  expect(local).toBe(true)
  expect(issues.map((i) => i.code)).toEqual(['vercel_queue', 'vercel_env_hidden'])
  expect(issues[1]!.message).toContain('(DATABASE_URL), so the database checks were skipped')
})

it('with SSR, builds the SSR bundle first and puts it in the function', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n')
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'resources/ssr.tsx'), 'export default async () => ({ head: [], body: "" })\n')
  vercelSetup(openProject(dir))
  expect(JSON.parse(readFileSync(join(dir, 'vercel.json'), 'utf8')).buildCommand).toBe('caldera generate && vite build && vite build --ssr && caldera vercel:build')
  mkdirSync(join(dir, 'build/ssr'), { recursive: true })
  writeFileSync(join(dir, 'build/ssr/ssr.js'), "import { renderToString } from 'react-dom/server'\nexport default async (page) => ({ head: [], body: renderToString(page.component) })\n")
  writeFileSync(join(dir, 'src/http.ts'), "import { Hono } from 'hono'\nexport const http = new Hono()\n")
  const result = await vercelBuild(openProject(dir), async () => undefined)
  expect(result.ssr).toBe(true)
  const bundle = readFileSync(join(dir, result.bundle), 'utf8')
  expect(bundle).toContain('setSsrRender(')
  expect(bundle).toContain('from "react-dom/server"')
})
