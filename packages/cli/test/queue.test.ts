import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueue } from '@caldera/queue'
import { bullmqDriver } from '@caldera/queue/bullmq'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failedJobs, generate, make, openProject, queueTable } from '../src/index.js'
import { Greet } from './fixtures/queue-app/src/jobs/greet.js'
import { hasRedis, startRedis } from './redis-server.js'

const here = import.meta.dirname
const bin = join(here, '../bin/caldera.js')
const tmp = join(here, '.tmp')
const PREFIX = 'queue-'
let redis: Awaited<ReturnType<typeof startRedis>> | undefined
let root: string
let out: string

beforeAll(async () => {
  if (!hasRedis) return
  redis = await startRedis()
  root = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  out = mkdtempSync(join(tmpdir(), 'caldera-worker-'))
  await generate(openProject(root))
})
afterAll(async () => {
  await redis?.stop()
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
  if (out) rmSync(out, { recursive: true, force: true })
})

async function until(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.runIf(hasRedis)('caldera queue:work', () => {
  it('runs jobs from src/jobs, retries them, logs JSON lines, and stops cleanly on SIGTERM', async () => {
    const worker = spawn(process.execPath, [bin, 'queue:work', '--cwd', root, '--json'], { env: { ...process.env, REDIS_URL: redis!.url, OUT_DIR: out } })
    let output = ''
    worker.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    worker.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const lines = () => output.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>)
    await until(() => lines().some((l) => l.type === 'started'))
    expect(lines()[0]).toMatchObject({ type: 'started', jobs: ['fixture.greet'] })

    const queue = createQueue({ default: 'redis', connections: { redis: { driver: 'bullmq', url: redis!.url } } }, { drivers: [bullmqDriver] })
    await queue.dispatch(Greet, { name: 'ann' })
    await queue.dispatch(Greet, { name: 'flaky' })
    await until(() => existsSync(join(out, 'ann.txt')) && existsSync(join(out, 'flaky.txt')))
    expect(readFileSync(join(out, 'flaky.txt'), 'utf8')).toBe('hello flaky on attempt 2')
    expect(lines().filter((l) => l.type === 'job').map((l) => `${l.job}:${l.status}`).sort()).toEqual(['fixture.greet:done', 'fixture.greet:done', 'fixture.greet:retry'])
    await queue.manager.purge()

    const exited = new Promise<number | null>((resolve) => worker.once('exit', resolve))
    worker.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(lines().at(-1)).toMatchObject({ type: 'stopped' })
  }, 30_000)
})

it('generates the job list edge consumers import', async () => {
  const dir = join(tmp, `${PREFIX}gen-${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  await generate(openProject(dir))
  expect(readFileSync(join(dir, '.caldera/jobs.gen.ts'), 'utf8')).toContain(`import * as jobs0 from '../src/jobs/greet.js'\n\nexport const jobs = [jobs0.Greet] as const\n`)
  rmSync(dir, { recursive: true, force: true })
})

it('make:job creates a job in src/jobs', async () => {
  const dir = join(tmp, `${PREFIX}make-${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  const result = await make(openProject(dir), 'job', 'SendWelcomeEmail')
  expect(result.created).toEqual(['src/jobs/send-welcome-email.ts'])
  expect(readFileSync(join(dir, 'src/jobs/send-welcome-email.ts'), 'utf8')).toContain(`export const SendWelcomeEmail = defineJob({\n  name: 'send-welcome-email',`)
  rmSync(dir, { recursive: true, force: true })
})

it('queue:table writes the jobs table for the app’s dialect, and won’t overwrite it', () => {
  const dir = join(tmp, `${PREFIX}table-${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  expect(queueTable(openProject(dir)).created).toEqual(['src/db/tables/caldera-jobs.ts'])
  expect(readFileSync(join(dir, 'src/db/tables/caldera-jobs.ts'), 'utf8')).toContain("bigint('available_at', { mode: 'number' }).notNull()")
  expect(() => queueTable(openProject(dir))).toThrow(/Refusing to overwrite/)
  writeFileSync(join(dir, 'drizzle.config.ts'), "export default { dialect: 'turso' }\n")
  queueTable(openProject(dir), { force: true })
  expect(readFileSync(join(dir, 'src/db/tables/caldera-jobs.ts'), 'utf8')).toContain("import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'")
  rmSync(dir, { recursive: true, force: true })
})

it.runIf(hasRedis)('queue:failed explains connections that keep no failed jobs', async () => {
  const dir = join(tmp, `${PREFIX}failed-${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  await generate(openProject(dir))
  process.env.REDIS_URL = redis!.url
  process.env.OUT_DIR = dir
  try {
    await expect(failedJobs(openProject(dir))).rejects.toThrow(/queue.redis doesn't keep failed jobs. The database driver does/)
  } finally {
    delete process.env.REDIS_URL
    delete process.env.OUT_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

it('generate survives a deleted file that the generated lists still import', async () => {
  const dir = join(tmp, `${PREFIX}repair-${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  writeFileSync(join(dir, 'src/jobs/extra.ts'), readFileSync(join(dir, 'src/jobs/greet.ts'), 'utf8').replaceAll('Greet', 'Extra').replaceAll('fixture.greet', 'fixture.extra'))
  await generate(openProject(dir))
  // Loaded by generate itself (configs are), so a stale list would break the load.
  writeFileSync(join(dir, 'src/config/jobs.ts'), "import { defineConfig } from '@caldera/core'\nimport { jobs } from '../../.caldera/jobs.gen.js'\n\nexport const jobList = defineConfig('jobList', () => ({ names: jobs.map((j) => j.name) }))\n")
  await generate(openProject(dir))
  expect(readFileSync(join(dir, '.caldera/jobs.gen.ts'), 'utf8')).toContain('jobs0.Extra')
  rmSync(join(dir, 'src/jobs/extra.ts'))
  await generate(openProject(dir))
  expect(readFileSync(join(dir, '.caldera/jobs.gen.ts'), 'utf8')).toContain(`import * as jobs0 from '../src/jobs/greet.js'\n\nexport const jobs = [jobs0.Greet] as const\n`)
  rmSync(dir, { recursive: true, force: true })
})
