import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { cloudflareSetup, d1Migrations, openProject } from '../src/index.js'
import { workersIssues } from '../src/cloudflare.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'cloudflare-'
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})
const fresh = () => {
  const dir = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  return dir
}

it('cloudflare:setup writes wrangler.json and a worker entry, and refuses to overwrite them', async () => {
  const dir = fresh()
  const result = await cloudflareSetup(openProject(dir))
  expect(result.created).toEqual(['wrangler.json', 'src/worker.ts', '.dev.vars.example'])
  const wrangler = JSON.parse(readFileSync(join(dir, 'wrangler.json'), 'utf8'))
  expect(wrangler).toMatchObject({
    name: 'fixture-queue-app',
    main: 'src/worker.ts',
    compatibility_flags: ['nodejs_compat'],
    assets: { directory: 'public', binding: 'ASSETS' },
    d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'FILES' }],
    queues: { consumers: [{ max_retries: 0 }] },
    send_email: [{ name: 'EMAIL' }],
    vars: { QUEUE_CONNECTION: 'cloudflare', MAIL_MAILER: 'cloudflare' },
  })
  const worker = readFileSync(join(dir, 'src/worker.ts'), 'utf8')
  expect(worker).toContain("import { jobs } from '../.caldera/jobs.gen.js'")
  expect(worker).toContain('handleQueueBatch(app, batch, env, { jobs })')
  await expect(cloudflareSetup(openProject(dir))).rejects.toThrow(/Refusing to overwrite wrangler.json, src\/worker.ts/)
})

it('d1:migrations flattens drizzle migrations for Wrangler, skipping unchanged ones', () => {
  const dir = fresh()
  mkdirSync(join(dir, 'drizzle/20261030120000_first'), { recursive: true })
  writeFileSync(join(dir, 'drizzle/20261030120000_first/migration.sql'), 'create table a (id integer);')
  writeFileSync(join(dir, 'drizzle/20261030120000_first/snapshot.json'), '{}')
  expect(d1Migrations(openProject(dir)).copied).toEqual(['migrations/20261030120000_first.sql'])
  expect(readFileSync(join(dir, 'migrations/20261030120000_first.sql'), 'utf8')).toBe('create table a (id integer);')
  expect(d1Migrations(openProject(dir))).toMatchObject({ copied: [], unchanged: ['migrations/20261030120000_first.sql'] })
})

it('reports the defaults that can’t run on Workers, booting with wrangler.json’s vars and bindings', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'wrangler.jsonc'), '{\n  // comments are fine\n  "vars": { "MAILER": "smtp" },\n  "d1_databases": [{ "binding": "DB" }],\n}\n')
  mkdirSync(join(dir, 'src/mail'), { recursive: true })
  writeFileSync(join(dir, 'src/mail/promo.tsx'), 'export const x = <Tailwind><p /></Tailwind>\n')
  let seen: Record<string, unknown> = {}
  const issues = await workersIssues(openProject(dir), async (env) => {
    seen = env
    return {
      config: {
        mail: { default: env.MAILER, mailers: { smtp: { driver: 'smtp' } } },
        queue: { default: 'db', connections: { db: { driver: 'database' } } },
        storage: { default: 'r2', disks: { r2: { driver: 'r2' } } },
        cache: { default: 'database', stores: { database: { driver: 'database' } } },
      },
      shutdown: async () => {},
    }
  })
  expect(seen.MAILER).toBe('smtp')
  expect(typeof seen.DB).toBe('object')
  expect(issues.map((i) => [i.code, i.severity])).toEqual([
    ['workers_smtp', 'error'],
    ['workers_queue', 'error'],
    ['workers_tailwind', 'warning'],
  ])
})
