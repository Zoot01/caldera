import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateAuthSchema, type AuthTableDescriptor } from '@caldera/auth'
import { CalderaError } from '@caldera/core'
import { loadApp, projectEnv } from './describe.js'
import type { Project } from './project.js'

export const AUTH_SCHEMA_FILE = 'src/db/auth-schema.ts'

export interface AuthSchemaResult {
  schemaVersion: 1
  file: string
  status: 'created' | 'updated' | 'unchanged' | 'stale'
  dialect: 'pg' | 'sqlite'
  tables: string[]
  /** Fields plugins add to the user model; add them to your users table yourself. */
  userFields: { name: string; type: string; required: boolean }[]
}

interface AuthServices {
  auth?: { options?: { advanced?: { database?: { generateId?: unknown } } } }
  db?: { driver?: string }
}

/**
 * Boots the app, reads the Better Auth instance from betterAuthProvider, and writes Drizzle code
 * for every table its config (including plugins) needs, except the app-owned users table.
 */
export async function generateProjectAuthSchema(project: Project, options: { check?: boolean; dialect?: 'pg' | 'sqlite' } = {}): Promise<AuthSchemaResult> {
  const app = await loadApp(project)
  await app.boot({ env: projectEnv(project) })
  try {
    const services = (app as unknown as { services: AuthServices }).services
    const auth = services.auth
    if (!auth?.options) throw new CalderaError('missing_auth', 'No Better Auth instance found. Add betterAuthProvider() to src/app.ts.')
    const dialect = options.dialect ?? dialectFor(services.db?.driver)
    const { getAuthTables } = await project.importPackage<{ getAuthTables(options: unknown): Record<string, AuthTableDescriptor> }>('better-auth/db')
    const generated = generateAuthSchema(getAuthTables(auth.options), {
      dialect,
      idType: auth.options.advanced?.database?.generateId === 'uuid' ? 'uuid' : 'text',
    })

    const target = project.path(AUTH_SCHEMA_FILE)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null
    let status: AuthSchemaResult['status'] = current === generated.code ? 'unchanged' : current === null ? 'created' : 'updated'
    if (status !== 'unchanged') {
      if (options.check) status = 'stale'
      else {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, generated.code)
      }
    }
    return { schemaVersion: 1, file: AUTH_SCHEMA_FILE, status, dialect, tables: generated.tables, userFields: generated.userFields }
  } finally {
    await app.shutdown()
  }
}

function dialectFor(driver: string | undefined): 'pg' | 'sqlite' {
  if (driver === 'postgres' || driver === 'neon-http') return 'pg'
  if (driver === 'sqlite' || driver === 'sqlite-sync' || driver === 'd1') return 'sqlite'
  throw new CalderaError('unknown_dialect', `Can't tell the SQL dialect${driver ? ` of driver "${driver}"` : ''}. Pass --dialect pg or --dialect sqlite.`)
}
