import { CalderaError } from '@caldera/core'
import { defaultDatabase, type Database } from './database.js'
import { changeSeed, currentSeed } from './seed-state.js'

export interface SeederContext {
  db: Database<any>
  environment: string
  log(message: string): void
}

export interface SeederDefinition {
  readonly kind: 'caldera.seeder'
  readonly name: string
  /** Only run in these environments. Omit to run everywhere except production. */
  readonly environments?: readonly string[]
  /** Allowed to run in production (still requires --force). Off by default. */
  readonly production: boolean
  readonly dependsOn: readonly SeederDefinition[]
  readonly run: (ctx: SeederContext) => unknown
}

export function defineSeeder(definition: {
  name: string
  environments?: readonly string[]
  production?: boolean
  dependsOn?: readonly SeederDefinition[]
  run: (ctx: SeederContext) => unknown
}): SeederDefinition {
  return { kind: 'caldera.seeder', production: false, dependsOn: [], ...definition }
}

export interface SeedReport {
  schemaVersion: 1
  /** Faker seed used: rerun with the same value to get the same data. */
  seed: number
  environment: string
  seeders: { name: string; status: 'ran' | 'skipped'; reason?: string; ms: number; logs: string[] }[]
}

export interface RunSeedersOptions {
  environment: string
  /** Required to seed production, and then only seeders marked `production: true` run. */
  force?: boolean
  seed?: number
  /** Run only these seeders (plus their dependencies). */
  only?: readonly string[]
  database?: Database<any>
}

/**
 * Runs seeders in dependency order, each at most once, inside one transaction when the driver
 * supports it, so a failing seeder leaves the database untouched.
 */
export async function runSeeders(seeders: readonly SeederDefinition[], options: RunSeedersOptions): Promise<SeedReport> {
  const production = options.environment === 'production'
  if (production && !options.force) {
    throw new CalderaError('confirmation_required', 'Refusing to seed with NODE_ENV=production. Pass --force if you mean it.')
  }
  if (options.seed !== undefined) changeSeed(options.seed)

  const selected = options.only ? seeders.filter((s) => options.only!.includes(s.name)) : seeders
  if (options.only) {
    const missing = options.only.filter((name) => !seeders.some((s) => s.name === name))
    if (missing.length) throw new CalderaError('unknown_seeder', `Unknown seeder(s): ${missing.join(', ')}.`, { missing })
  }
  const ordered = sortSeeders(selected)
  const db = options.database ?? defaultDatabase()
  const report: SeedReport = { schemaVersion: 1, seed: currentSeed(), environment: options.environment, seeders: [] }

  const runAll = async () => {
    for (const seeder of ordered) {
      const skip = skipReason(seeder, options.environment, production)
      if (skip) {
        report.seeders.push({ name: seeder.name, status: 'skipped', reason: skip, ms: 0, logs: [] })
        continue
      }
      const logs: string[] = []
      const started = performance.now()
      await seeder.run({ db, environment: options.environment, log: (message) => void logs.push(message) })
      report.seeders.push({ name: seeder.name, status: 'ran', ms: Math.round(performance.now() - started), logs })
    }
  }
  if (db.capabilities.interactiveTransactions) await db.transaction(runAll)
  else await runAll()
  return report
}

function skipReason(seeder: SeederDefinition, environment: string, production: boolean): string | undefined {
  if (production && !seeder.production) return 'not marked production: true'
  if (seeder.environments && !seeder.environments.includes(environment)) return `only runs in ${seeder.environments.join(', ')}`
  return undefined
}

/** Dependencies first; each seeder once. Dependencies are included even if not listed. */
export function sortSeeders(seeders: readonly SeederDefinition[]): SeederDefinition[] {
  const sorted: SeederDefinition[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (seeder: SeederDefinition, path: string[]) => {
    if (done.has(seeder.name)) return
    if (visiting.has(seeder.name)) {
      throw new CalderaError('seeder_cycle', `Seeders depend on each other in a cycle: ${[...path, seeder.name].join(' → ')}`)
    }
    visiting.add(seeder.name)
    for (const dependency of seeder.dependsOn) visit(dependency, [...path, seeder.name])
    visiting.delete(seeder.name)
    done.add(seeder.name)
    sorted.push(seeder)
  }
  for (const seeder of seeders) visit(seeder, [])
  return sorted
}
