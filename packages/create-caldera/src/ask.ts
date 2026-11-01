import { DATABASES, detectPackageManager, KITS, targetsFor, unavailable, type CreateOptions, type Database, type Frontend, type Kit, type PackageManager, type Target } from './create.js'
import type { Prompter } from './prompt.js'

const MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const

export type Answers = Pick<CreateOptions, 'directory' | 'packageManager' | 'frontend' | 'kit' | 'teams' | 'database' | 'target' | 'install'>

/** Asks only for what wasn't given on the command line. */
export async function askCreateOptions(
  prompter: Prompter,
  given: { directory?: string; packageManager?: PackageManager; frontend?: Frontend; kit?: Kit; teams?: boolean; database?: Database; target?: Target; install?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Answers> {
  let directory = given.directory
  let question = 'Project name'
  // A free name by default; nothing is ever merged into an existing folder.
  let suggestion = unavailable('my-caldera-app') ?? 'my-caldera-app'
  const taken = (answer: string) => {
    const free = unavailable(answer)
    return free ? `${answer} already exists and isn't empty. Try ${free}.` : undefined
  }
  while (!directory) {
    const answer = await prompter.text(question, suggestion, taken)
    const free = unavailable(answer)
    if (!free) directory = answer
    else {
      // A prompter without inline validation: asked again, defaulting to a free name.
      question = `${answer} already exists and isn't empty. Project name`
      suggestion = free
    }
  }
  const frontend = given.frontend ?? 'inertia'
  const kit =
    given.kit ??
    (await prompter.select(
      'Starter kit',
      KITS,
      'starter',
      { starter: 'Auth, settings and a dashboard', blank: frontend === 'next' ? 'One page using Caldera from Next.js' : 'Tailwind and the UI kit, one page' },
      { starter: 'Starter', blank: 'Blank' },
    ))
  // Teams change the data model (every account gets a team), so they're asked for up front (the Inertia
  // starter only, for now). --teams with another kit is passed on, so creating refuses it as it would
  // without a terminal.
  const teams = kit === 'starter' && frontend === 'inertia' ? (given.teams ?? (await prompter.confirm('Add teams support?', false))) : given.teams
  const database =
    given.database ??
    (await prompter.select('Database', DATABASES, 'sqlite', { sqlite: 'A local file; Turso or D1 in production', postgres: 'Needs a Postgres server' }, { sqlite: 'SQLite', postgres: 'Postgres' }))
  const targets = targetsFor(frontend, database)
  const target =
    given.target ??
    (targets.length === 1
      ? targets[0]!
      : await prompter.select(
          'Deploy target',
          targets,
          'node',
          { node: 'Any server or container', vercel: 'Functions (Node.js runtime)', cloudflare: 'Workers, D1, R2 and Queues' },
          { node: 'Node server', vercel: 'Vercel', cloudflare: 'Cloudflare Workers' },
        ))
  const packageManager = given.packageManager ?? (await prompter.select('Package manager', MANAGERS, detectPackageManager(env)))
  const install = given.install ?? (await prompter.confirm('Install dependencies now?', true))
  return { directory, frontend, kit, ...(teams !== undefined ? { teams } : {}), database, target, packageManager, install }
}
