import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { generate, make, notificationsTable, openProject } from '../src/index.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'notifications-'
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})
const fresh = () => {
  const dir = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/queue-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  return dir
}

it('make:notification creates one in src/notifications, with its mail; generate registers both and lists it in AGENTS.md', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'AGENTS.md'), '# App\n\n<!-- caldera:generated:start -->\n<!-- caldera:generated:end -->\n')
  const result = await make(openProject(dir), 'notification', 'billing.InvoicePaid')
  expect(result.created).toEqual(['src/notifications/invoice-paid.ts', 'src/mail/invoice-paid.tsx'])
  expect(result.generate).toBe('ok')
  expect(result.hints[0]).toContain('await notify(user, InvoicePaid, { id })')
  const notification = readFileSync(join(dir, 'src/notifications/invoice-paid.ts'), 'utf8')
  expect(notification).toContain(`export const InvoicePaid = defineNotification({`)
  expect(notification).toContain(`  name: 'billing.invoice-paid',`)
  expect(notification).toContain(`mail: (_to, { url }) => ({ mail: InvoicePaidEmail, props: { url } }),`)
  expect(readFileSync(join(dir, 'src/mail/invoice-paid.tsx'), 'utf8')).toContain(`  name: 'billing.invoice-paid',`)
  expect(readFileSync(join(dir, '.caldera/notifications.gen.ts'), 'utf8')).toContain(
    `import type { AnyNotification } from '@caldera/notifications'\nimport * as notifications0 from '../src/notifications/invoice-paid.js'\n\nexport const notifications: readonly AnyNotification[] = [notifications0.InvoicePaid]\n`,
  )
  // Registered by name, so inbox rows' data is typed by the notification's database schema.
  const register = readFileSync(join(dir, '.caldera/register.d.ts'), 'utf8')
  expect(register).toContain("import type * as notifications0 from '../src/notifications/invoice-paid.js'")
  expect(register).toContain(`declare module '@caldera/notifications' {\n  interface NotificationRegistry {\n    "billing.invoice-paid": typeof notifications0.InvoicePaid\n  }\n}`)
  expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toMatch(/\| `billing.invoice-paid` \| `InvoicePaid` \| mail, database \| yes \| src\/notifications\/invoice-paid.ts \|/)

  // A mail that's already there is used as it is, even with --force.
  writeFileSync(join(dir, 'src/mail/invoice-paid.tsx'), readFileSync(join(dir, 'src/mail/invoice-paid.tsx'), 'utf8').replace('Open it', 'See the invoice'))
  const again = await make(openProject(dir), 'notification', 'billing.InvoicePaid', { force: true })
  expect(again.created).toEqual(['src/notifications/invoice-paid.ts'])
  expect(readFileSync(join(dir, 'src/mail/invoice-paid.tsx'), 'utf8')).toContain('See the invoice')
})

it('notifications:table writes the table for the app’s dialect, and refuses to overwrite it', async () => {
  const dir = fresh()
  const result = notificationsTable(openProject(dir))
  expect(result.created).toEqual(['src/db/tables/caldera-notifications.ts'])
  const pgTable = readFileSync(join(dir, result.created[0]!), 'utf8')
  expect(pgTable).toContain("data: jsonb('data').notNull()")
  expect(pgTable).toContain('.where(sql`${t.readAt} is null`)')
  expect(() => notificationsTable(openProject(dir))).toThrow(/Refusing to overwrite/)
  writeFileSync(join(dir, 'drizzle.config.ts'), "export default { dialect: 'sqlite' }\n")
  notificationsTable(openProject(dir), { force: true })
  expect(readFileSync(join(dir, result.created[0]!), 'utf8')).toContain("data: text('data').notNull()")
  await generate(openProject(dir))
})

it('cache:table writes the database cache table for the app’s dialect', async () => {
  const { cacheTable } = await import('../src/index.js')
  const dir = fresh()
  expect(readFileSync(join(dir, cacheTable(openProject(dir)).created[0]!), 'utf8')).toContain("expiresAt: bigint('expires_at', { mode: 'number' })")
  writeFileSync(join(dir, 'drizzle.config.ts'), "export default { dialect: 'turso' }\n")
  expect(readFileSync(join(dir, cacheTable(openProject(dir), { force: true }).created[0]!), 'utf8')).toContain("expiresAt: integer('expires_at')")
})
