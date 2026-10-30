import { cpSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

async function waitFor(events: DevEvent[], predicate: (e: DevEvent) => boolean) {
  for (let i = 0; i < 100; i++) {
    const found = events.find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`No matching dev event in ${JSON.stringify(events)}`)
}

it('regenerates on every change, survives errors and recovers', async () => {
  const events: DevEvent[] = []
  session = startDev(root, { server: false, debounce: 20, onEvent: (e) => void events.push(e) })
  await session.ready
  expect(events[0]).toMatchObject({ type: 'generated', changed: expect.arrayContaining(['.caldera/config.gen.ts', 'AGENTS.md']) })

  events.length = 0
  writeFileSync(join(root, 'src/config/mail.ts'), `import { defineConfig } from '@caldera/core'\nexport const mail = defineConfig('mail', () => ({ from: 'hi@example.test' }))\n`)
  await waitFor(events, (e) => e.type === 'generated' && e.changed.includes('.caldera/config.gen.ts'))
  expect(readFileSync(join(root, '.caldera/config.gen.ts'), 'utf8')).toContain('mail')

  events.length = 0
  writeFileSync(join(root, 'src/config/clash.ts'), `import { defineConfig } from '@caldera/core'\nexport const again = defineConfig('mail', () => ({}))\n`)
  expect((await waitFor(events, (e) => e.type === 'error')).error).toMatch(/Config "mail" is defined in both/)

  events.length = 0
  unlinkSync(join(root, 'src/config/clash.ts'))
  await waitFor(events, (e) => e.type === 'generated')
}, 30_000)
