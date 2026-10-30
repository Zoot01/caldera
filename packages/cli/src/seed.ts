import { CalderaError } from '@caldera/core'
import { runSeeders, type SeederDefinition, type SeedReport } from '@caldera/db/seeders'
import { loadApp, projectEnv } from './describe.js'
import { CONVENTIONS, exportsOfKind, seederFiles, type Project } from './project.js'

export interface SeedOptions {
  force?: boolean
  seed?: number
  only?: string[]
}

/** Every seeder exported from `src/db/seeders/*.ts`. */
export async function loadSeeders(project: Project): Promise<SeederDefinition[]> {
  const seeders: SeederDefinition[] = []
  for (const file of seederFiles(project)) {
    for (const { value } of exportsOfKind<SeederDefinition>(await project.load(file), 'caldera.seeder')) {
      if (!seeders.some((s) => s.name === value.name)) seeders.push(value)
    }
  }
  return seeders
}

/**
 * Boots the app (so its databaseProvider registers the default database), runs the seeders,
 * then shuts the app down. The environment comes from CALDERA_ENV, then NODE_ENV, then `local`.
 */
export async function seedProject(project: Project, options: SeedOptions = {}): Promise<SeedReport> {
  const env = projectEnv(project)
  // Empty values count as unset, as in defineEnv.
  const environment = String(env.CALDERA_ENV || env.NODE_ENV || 'local')
  const seeders = await loadSeeders(project)
  if (seeders.length === 0) {
    throw new CalderaError('no_seeders', `No seeders found in ${CONVENTIONS.seedersDir}.`)
  }
  const app = await loadApp(project)
  await app.boot({ env })
  try {
    return await runSeeders(seeders, { environment, force: options.force, seed: options.seed, only: options.only })
  } finally {
    await app.shutdown()
  }
}
