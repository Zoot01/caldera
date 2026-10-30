import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { generate, make, openProject } from '../src/index.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'events-'
let root: string

beforeEach(() => {
  root = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  writeFileSync(join(root, 'AGENTS.md'), '# app\n\n<!-- caldera:generated:start -->\n<!-- caldera:generated:end -->\n')
})
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

it('writes an empty listener list once the app uses events', async () => {
  await generate(openProject(root))
  expect(readFileSync(join(root, '.caldera/listeners.gen.ts'), 'utf8')).toContain('export const listeners = [] as const\n')
})

it('make:event and make:listener, then generate registers the listener and lists it in AGENTS.md', async () => {
  const project = openProject(root)
  expect((await make(project, 'event', 'UserRegistered')).created).toEqual(['src/events/user-registered.ts'])
  await expect(make(project, 'listener', 'NotifyAdmins')).rejects.toMatchObject({ code: 'missing_argument' })
  expect((await make(project, 'listener', 'NotifyAdmins', { event: 'UserRegistered' })).created).toEqual(['src/listeners/notify-admins.ts'])
  // A queued listener: the existing Greet job, on the same event.
  writeFileSync(
    join(root, 'src/listeners/greet-new-users.ts'),
    `import { listen } from '@caldera/events'\nimport { UserRegistered } from '../events/user-registered.js'\nimport { Greet } from '../jobs/greet.js'\n\nexport const greetNewUsers = listen(UserRegistered, Greet.fromEvent<{ id: string }>((e) => ({ name: e.id })))\n`,
  )
  await generate(openProject(root))
  expect(readFileSync(join(root, '.caldera/listeners.gen.ts'), 'utf8')).toContain(
    `import * as listeners0 from '../src/listeners/greet-new-users.js'\nimport * as listeners1 from '../src/listeners/notify-admins.js'\n\nexport const listeners = [listeners0.greetNewUsers, listeners1.notifyAdmins] as const\n`,
  )
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  expect(agents).toContain('| `user-registered` | `greetNewUsers` | queued: job `fixture.greet` | src/listeners/greet-new-users.ts |')
  expect(agents).toContain('| `user-registered` | `notifyAdmins` | in process | src/listeners/notify-admins.ts |')
})
