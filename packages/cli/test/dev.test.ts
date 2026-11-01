import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { startDev, type DevEvent, type DevSession } from '../src/index.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'dev-'
let root: string
let session: DevSession | undefined

beforeEach(() => {
  root = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/basic-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') && !src.includes('/drizzle/') })
})
afterEach(async () => {
  await session?.stop()
  rmSync(root, { recursive: true, force: true })
})
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

async function waitFor(events: DevEvent[], predicate: (e: DevEvent) => boolean, step = 'event') {
  const started = Date.now()
  // Generous: a change the file watcher misses is still caught by the ~2s modification-time check.
  for (let i = 0; i < 300; i++) {
    const found = events.find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`${step}: no matching dev event after ${Date.now() - started}ms in ${JSON.stringify(events)}`)
}

it('regenerates on every change, survives errors and recovers', async () => {
  const events: DevEvent[] = []
  session = startDev(root, { server: false, debounce: 20, onEvent: (e) => void events.push(e) })
  await session.ready
  expect(events[0]).toMatchObject({ type: 'generated', changed: expect.arrayContaining(['.caldera/config.gen.ts', 'AGENTS.md']) })

  events.length = 0
  writeFileSync(join(root, 'src/config/mail.ts'), `import { defineConfig } from '@caldera-js/core'\nexport const mail = defineConfig('mail', () => ({ from: 'hi@example.test' }))\n`)
  await waitFor(events, (e) => e.type === 'generated' && e.changed.includes('.caldera/config.gen.ts'), 'add mail.ts')
  expect(readFileSync(join(root, '.caldera/config.gen.ts'), 'utf8')).toContain('mail')

  events.length = 0
  writeFileSync(join(root, 'src/config/clash.ts'), `import { defineConfig } from '@caldera-js/core'\nexport const again = defineConfig('mail', () => ({}))\n`)
  expect((await waitFor(events, (e) => e.type === 'error', 'add clash.ts')).error).toMatch(/Config "mail" is defined in both/)

  events.length = 0
  unlinkSync(join(root, 'src/config/clash.ts'))
  await waitFor(events, (e) => e.type === 'generated', 'remove clash.ts')
}, 60_000)

it('polls instead of watching with poll, catching new, edited and deleted files', async () => {
  const events: DevEvent[] = []
  session = startDev(root, { server: false, poll: true, interval: 50, debounce: 20, onEvent: (e) => void events.push(e) })
  await session.ready

  events.length = 0
  const mail = join(root, 'src/config/mail.ts')
  writeFileSync(mail, `import { defineConfig } from '@caldera-js/core'\nexport const mail = defineConfig('mail', () => ({ from: 'hi@example.test' }))\n`)
  await waitFor(events, (e) => e.type === 'generated' && e.changed.includes('.caldera/config.gen.ts'), 'add mail.ts')
  expect(readFileSync(join(root, '.caldera/config.gen.ts'), 'utf8')).toContain('mail')

  events.length = 0
  // Same size, so only the modification time differs.
  writeFileSync(mail, readFileSync(mail, 'utf8').replace('hi@', 'yo@'))
  await waitFor(events, (e) => e.type === 'generated', 'edit mail.ts')

  events.length = 0
  unlinkSync(mail)
  await waitFor(events, (e) => e.type === 'generated' && e.changed.includes('.caldera/config.gen.ts'), 'remove mail.ts')
  expect(readFileSync(join(root, '.caldera/config.gen.ts'), 'utf8')).not.toContain('mail')
}, 60_000)

it('catches what the file watcher misses: a pages folder made after dev started', async () => {
  rmSync(root, { recursive: true, force: true })
  cpSync(join(here, 'fixtures/inertia-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') && !src.includes('/resources') })
  const events: DevEvent[] = []
  session = startDev(root, { server: false, interval: 100, debounce: 20, onEvent: (e) => void events.push(e) })
  await session.ready
  expect(readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')).not.toContain("'Late'")

  // Not watched (it didn't exist), so only the modification-time check can see this.
  events.length = 0
  mkdirSync(join(root, 'resources/pages'), { recursive: true })
  writeFileSync(join(root, 'resources/pages/Late.tsx'), `export default function Late() {\n  return null\n}\n`)
  await waitFor(events, (e) => e.type === 'generated' && e.changed.includes('.caldera/register.d.ts'), 'add resources/pages/Late.tsx')
  expect(readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')).toContain("'Late'")
}, 60_000)
