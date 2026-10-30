import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { CalderaError, type AppDescription } from '@caldera/core'
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

/**
 * Loads `src/app.ts`, boots it with the project's `.env` (real environment variables
 * win), and returns `app.describe()`. Booting never builds singletons, so this opens
 * no database connections. With `boot: false` it describes the app without env.
 */
export async function describeProject(project: Project, options: { boot?: boolean } = {}): Promise<AppDescription> {
  const module = await project.load(CONVENTIONS.app)
  const app = module.app ?? module.default
  if (!isApp(app)) {
    throw new CalderaError('app_definition', `${CONVENTIONS.app} must export the result of createApp(...) as \`app\`.`)
  }
  if (options.boot !== false) await app.boot({ env: { ...readDotEnv(project), ...process.env } })
  return app.describe()
}

function readDotEnv(project: Project): Record<string, string> {
  const file = project.path('.env')
  return existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {}
}
