import { detectPackageManager, FRONTENDS, unavailable, type CreateOptions, type Frontend, type PackageManager } from './create.js'
import type { Prompter } from './prompt.js'

const MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const

/** Asks only for what wasn't given on the command line. */
export async function askCreateOptions(
  prompter: Prompter,
  given: { directory?: string; packageManager?: PackageManager; frontend?: Frontend; install?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pick<CreateOptions, 'directory' | 'packageManager' | 'frontend' | 'install'>> {
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
  const frontend =
    given.frontend ??
    (await prompter.select('Frontend', FRONTENDS, 'inertia', { inertia: 'React pages served by the app', next: 'Next.js, with Caldera at /api' }))
  const packageManager = given.packageManager ?? (await prompter.select('Package manager', MANAGERS, detectPackageManager(env)))
  const install = given.install ?? (await prompter.confirm('Install dependencies now?', true))
  return { directory, frontend, packageManager, install }
}
