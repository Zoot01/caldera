import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { generate, listSchedules, make, openProject, startScheduleWorker, syncSchedules } from '../src/index.js'

const here = import.meta.dirname
const bin = join(here, '../bin/caldera.js')
const tmp = join(here, '.tmp')
const PREFIX = 'schedule-'
let root: string

beforeEach(async () => {
  root = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/schedule-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  writeFileSync(join(root, 'AGENTS.md'), '# app\n\n<!-- caldera:generated:start -->\n<!-- caldera:generated:end -->\n')
  await generate(openProject(root))
})
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

it('registers schedules and lists them in AGENTS.md', () => {
  expect(readFileSync(join(root, '.caldera/schedules.gen.ts'), 'utf8')).toContain('export const schedules: readonly AnySchedule[] = [schedules0.everyMinute, schedules1.nightly]\n')
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  expect(agents).toContain('| `stamp.nightly` | `0 2 * * *` (Europe/Paris) | `stamp` | one server | src/schedules/nightly.ts |')
})

it('lists next runs without booting the app', async () => {
  const { schedules } = await listSchedules(openProject(root), new Date('2026-11-02T10:00:30Z'))
  expect(schedules.map((s) => [s.name, s.next])).toEqual([
    ['stamp.every-minute', '2026-11-02T10:01:00.000Z'],
    ['stamp.nightly', '2026-11-03T01:00:00.000Z'], // 02:00 in Paris (CET)
  ])
})

it('schedule:run dispatches what is due (and onOneServer works with the app’s cache)', () => {
  const result = spawnSync(process.execPath, [bin, 'schedule:run', '--cwd', root, '--json'], { encoding: 'utf8', env: { ...process.env, OUT_DIR: root } })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).results).toEqual([expect.objectContaining({ name: 'stamp.every-minute', status: 'dispatched' })])
  expect(readFileSync(join(root, 'stamps.log'), 'utf8')).toBe('tick\n')
})

it('schedule:run --name runs one schedule now, whatever its cron says', () => {
  const result = spawnSync(process.execPath, [bin, 'schedule:run', '--name', 'stamp.nightly', '--cwd', root, '--json'], { encoding: 'utf8', env: { ...process.env, OUT_DIR: root } })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).results).toEqual([expect.objectContaining({ name: 'stamp.nightly', status: 'dispatched' })])
  const missing = spawnSync(process.execPath, [bin, 'schedule:run', '--name', 'nope', '--cwd', root, '--json'], { encoding: 'utf8' })
  expect(missing.status).not.toBe(0)
  expect(JSON.parse(missing.stdout).error).toMatchObject({ code: 'schedule_missing', message: expect.stringContaining('stamp.nightly') })
})

it('schedule:work runs the current minute at once, then stops cleanly', async () => {
  process.env.OUT_DIR = root
  const ticks: unknown[] = []
  const worker = await startScheduleWorker(openProject(root), (t) => void ticks.push(t))
  await worker.stop()
  delete process.env.OUT_DIR
  expect(ticks).toHaveLength(1)
  expect(readFileSync(join(root, 'stamps.log'), 'utf8')).toBe('tick\n')
})

describe('schedule:sync', () => {
  it('vercel: one entry per schedule, keeping other crons and settings, with warnings', async () => {
    writeFileSync(join(root, 'vercel.json'), JSON.stringify({ framework: 'hono', crons: [{ path: '/api/mine', schedule: '0 5 * * *' }, { path: '/_caldera/cron?schedule=gone', schedule: '1 1 * * *' }] }))
    const result = await syncSchedules(openProject(root), 'vercel')
    expect(result.status).toBe('updated')
    expect(JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))).toEqual({
      framework: 'hono',
      crons: [
        { path: '/api/mine', schedule: '0 5 * * *' },
        { path: '/_caldera/cron?schedule=stamp.every-minute', schedule: '* * * * *' },
        { path: '/_caldera/cron?schedule=stamp.nightly', schedule: '0 2 * * *' },
      ],
    })
    expect(result.warnings).toEqual([
      expect.stringContaining("stamp.every-minute (* * * * *) runs more than once a day: Vercel's Hobby plan allows daily crons only"),
      expect.stringContaining('stamp.nightly runs in Europe/Paris, but Vercel Cron runs in UTC'),
    ])
    expect((await syncSchedules(openProject(root), 'vercel', { check: true })).status).toBe('unchanged')
  })

  it('cloudflare: one every-minute trigger, added or replaced in wrangler.toml, nothing else touched', async () => {
    const toml = `name = "app"\nmain = "src/worker.ts"\n\n[[queues.producers]]\nqueue = "jobs"\nbinding = "JOBS"\n`
    writeFileSync(join(root, 'wrangler.toml'), toml)
    expect((await syncSchedules(openProject(root), 'cloudflare', { check: true })).status).toBe('stale')
    await syncSchedules(openProject(root), 'cloudflare')
    expect(readFileSync(join(root, 'wrangler.toml'), 'utf8')).toBe(`${toml}\n[triggers]\ncrons = ["* * * * *"]\n`)
    writeFileSync(join(root, 'wrangler.toml'), `name = "app"\n\n[triggers]\ncrons = ["0 * * * *", "5 5 * * *"]\n\n[vars]\nA = "1"\n`)
    await syncSchedules(openProject(root), 'cloudflare')
    expect(readFileSync(join(root, 'wrangler.toml'), 'utf8')).toBe(`name = "app"\n\n[triggers]\ncrons = ["* * * * *"]\n\n[vars]\nA = "1"\n`)
  })

  it('refuses to rewrite wrangler.jsonc (comments would be lost)', async () => {
    writeFileSync(join(root, 'wrangler.jsonc'), '{ // mine\n}')
    await expect(syncSchedules(openProject(root), 'cloudflare')).rejects.toMatchObject({ code: 'wrangler_jsonc' })
  })
})

it('make:schedule needs --job and writes src/schedules', async () => {
  await expect(make(openProject(root), 'schedule', 'Cleanup')).rejects.toMatchObject({ code: 'missing_argument' })
  const result = await make(openProject(root), 'schedule', 'Cleanup', { job: 'Stamp' })
  expect(result.created).toEqual(['src/schedules/cleanup.ts'])
  expect(readFileSync(join(root, 'src/schedules/cleanup.ts'), 'utf8')).toContain("import { Stamp } from '../jobs/stamp.js'")
  // Stamp needs a label: the error names the schedule, the job and the field.
  await expect(listSchedules(openProject(root))).rejects.toThrow(`Schedule "cleanup": its payload doesn't fit job "stamp" (label: Invalid input: expected string, received undefined). Set \`payload\`.`)
  const file = join(root, 'src/schedules/cleanup.ts')
  writeFileSync(file, readFileSync(file, 'utf8').replace('// payload: { ... },', "payload: { label: 'cleanup' },"))
  expect((await listSchedules(openProject(root))).schedules.map((s) => s.name)).toContain('cleanup')
})
