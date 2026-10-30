import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CalderaError } from '@caldera/core'
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
