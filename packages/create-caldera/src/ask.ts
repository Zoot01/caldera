import { detectPackageManager, unavailable, type CreateOptions, type PackageManager } from './create.js'
import type { Prompter } from './prompt.js'

const MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const

/** Asks only for what wasn't given on the command line. */
export async function askCreateOptions(
  prompter: Prompter,
  given: { directory?: string; packageManager?: PackageManager; install?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pick<CreateOptions, 'directory' | 'packageManager' | 'install'>> {
  let directory = given.directory
  let question = 'Project name'
  let suggestion = 'my-caldera-app'
  while (!directory) {
    const answer = await prompter.text(question, suggestion)
    const free = unavailable(answer)
    if (!free) directory = answer
    else {
      // Asked again, defaulting to a free name; nothing is ever merged into an existing folder.
      question = `${answer} already exists and isn't empty. Project name`
      suggestion = free
    }
  }
  const packageManager = given.packageManager ?? (await prompter.select('Package manager', MANAGERS, detectPackageManager(env)))
  const install = given.install ?? (await prompter.confirm('Install dependencies now?', true))
  return { directory, packageManager, install }
}
