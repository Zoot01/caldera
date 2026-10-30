import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { CalderaError, type AppDescription } from '@caldera/core'
import { installMailOutbox } from './dev-outbox.js'
import { CONVENTIONS, type Project } from './project.js'

interface DescribableApp {
  boot(options?: { env?: Record<string, unknown> }): Promise<unknown>
  describe(): AppDescription
}

function isApp(value: unknown): value is DescribableApp {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DescribableApp).boot === 'function' &&
    typeof (value as DescribableApp).describe === 'function'
  )
}

/** Loads `src/app.ts` and returns the app it exports. */
export async function loadApp(project: Project): Promise<DescribableApp & { shutdown(): Promise<void> }> {
  const module = await project.load(CONVENTIONS.app)
  const app = module.app ?? module.default
  if (!isApp(app)) {
    throw new CalderaError('app_definition', `${CONVENTIONS.app} must export the result of createApp(...) as \`app\`.`)
  }
  return app as DescribableApp & { shutdown(): Promise<void> }
}

/** The project's `.env`, with real environment variables taking precedence. */
export function projectEnv(project: Project): Record<string, unknown> {
  return { ...readDotEnv(project), ...process.env }
}

/**
 * Loads `src/app.ts`, boots it with the project's `.env` (real environment variables
 * win), and returns `app.describe()`. Booting never builds singletons, so this opens
 * no database connections. With `boot: false` it describes the app without env.
 */
export async function describeProject(project: Project, options: { boot?: boolean } = {}): Promise<AppDescription> {
  const app = await loadApp(project)
  if (options.boot !== false) await app.boot({ env: projectEnv(project) })
  return app.describe()
}

function readDotEnv(project: Project): Record<string, string> {
  const file = project.path('.env')
  return existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {}
}

export const MAIL_OUTBOX_FILE = '.caldera/mail-outbox.jsonl'

/**
 * Development: a queue worker or scheduler sharing the dev server's mail outbox, so mail they send
 * shows at /_caldera/mail/outbox (the `log` mailer appends to the file). Never in production.
 */
export function shareMailOutbox(project: Project) {
  const env = projectEnv(project)
  if (env.NODE_ENV === 'production') return
  mkdirSync(project.path(CONVENTIONS.generatedDir), { recursive: true })
  installMailOutbox(process.env.CALDERA_MAIL_OUTBOX || project.path(MAIL_OUTBOX_FILE))
}
