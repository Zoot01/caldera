import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CalderaError } from '@caldera-js/core'
import type { Project } from './project.js'

export type MigrationCommand = 'generate' | 'migrate' | 'push'

/** Commands that change a database. They need `--force` in production, as in Laravel. */
const WRITES_DATABASE = new Set<MigrationCommand>(['migrate', 'push'])

export interface MigrationRun {
  command: MigrationCommand
  exitCode: number
  output: string
}

/**
 * Finds the project's own drizzle-kit, so its version always matches the project's drizzle-orm.
 * Walks up node_modules like Node does: drizzle-kit doesn't export package.json, so
 * require.resolve can't be used.
 */
export function resolveDrizzleKit(project: Project): string {
  let dir = project.root
  while (true) {
    const bin = join(dir, 'node_modules', 'drizzle-kit', 'bin.cjs')
    if (existsSync(bin)) return bin
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new CalderaError('missing_dependency', 'drizzle-kit is not installed in this project. Install it with `pnpm add -D drizzle-kit`.', {
    package: 'drizzle-kit',
  })
}

/**
 * Runs `drizzle-kit <command>` in the project. With `capture`, output is collected for JSON
 * mode; otherwise it streams to the terminal, which drizzle-kit's prompts need.
 */
export function runMigrations(
  project: Project,
  command: MigrationCommand,
  options: { force?: boolean; capture?: boolean; extraArgs?: string[]; env?: NodeJS.ProcessEnv } = {},
): MigrationRun {
  const env = options.env ?? process.env
  if (WRITES_DATABASE.has(command) && env.NODE_ENV === 'production' && !options.force) {
    throw new CalderaError('confirmation_required', `Refusing to run db:${command} with NODE_ENV=production. Pass --force if you mean it.`, {
      command,
    })
  }
  if (!existsSync(project.path('drizzle.config.ts'))) {
    throw new CalderaError('missing_file', 'Expected drizzle.config.ts in the project root (see https://orm.drizzle.team/docs/drizzle-config-file).', {
      file: 'drizzle.config.ts',
    })
  }
  const bin = resolveDrizzleKit(project)
  const result = spawnSync(process.execPath, [bin, command, ...(options.extraArgs ?? [])], {
    cwd: project.root,
    env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  return { command, exitCode: result.status ?? 1, output: options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}` : '' }
}

/**
 * After migrating a local SQLite file (`DATABASE_URL=file:…`): WAL mode, so the app, the worker and
 * the scheduler, each its own process, share it without "database is locked" (readers never wait for
 * a writer; writers wait out the connection's busy timeout). It's stored in the file, so setting it
 * once, when the deploy migrates, is enough. Turso, Postgres and D1 are left alone. Returns the mode.
 */
export async function sqliteWal(project: Project, env: Record<string, unknown>): Promise<string | undefined> {
  const url = env.DATABASE_URL
  if (typeof url !== 'string' || !url.startsWith('file:') || url.includes(':memory:')) return undefined
  const path = url.slice('file:'.length)
  // Relative to the project, as drizzle-kit (run there) read it.
  const absolute = isAbsolute(path) ? path : join(project.root, path)
  let libsql: { createClient(config: { url: string }): { execute(sql: string): Promise<{ rows: unknown[][] }>; close(): void } }
  try {
    libsql = await import(pathToFileURL(createRequire(project.path('package.json')).resolve('@libsql/client')).href)
  } catch {
    return undefined
  }
  const client = libsql.createClient({ url: `file:${absolute}` })
  try {
    const result = await client.execute('PRAGMA journal_mode = WAL')
    return String(Object.values(result.rows[0] ?? {})[0] ?? '')
  } finally {
    client.close()
  }
}
