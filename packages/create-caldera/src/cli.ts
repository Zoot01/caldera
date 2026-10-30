import { cancel, intro, log, note, outro, spinner } from '@clack/prompts'
import { defineCommand, runMain } from 'citty'
import { askCreateOptions } from './ask.js'
import { createProject, CreateError, type CreateOptions, type CreateResult, type Frontend, type PackageManager, type Step } from './create.js'
import { clackPrompter, isInteractive, PromptCancelled } from './prompt.js'

// What each step is doing, for the spinner, and what it did.
const RUNNING: Record<Step['name'], string> = {
  files: 'Writing files',
  install: 'Installing dependencies',
  generate: 'Generating types',
  database: 'Creating the database',
  git: 'Creating a git repository',
}
const DONE: Record<Step['name'], string> = {
  files: 'Wrote the files',
  install: 'Installed dependencies',
  generate: 'Generated types',
  database: 'Created the database (the first migration)',
  git: 'Created a git repository',
}

const main = defineCommand({
  meta: { name: 'create-caldera', description: 'Create a Caldera app' },
  args: {
    directory: { type: 'positional', description: 'Folder to create (asked for in a terminal; default my-caldera-app)', required: false },
    pm: { type: 'enum', options: ['pnpm', 'npm', 'yarn', 'bun'], description: 'Package manager (default: the one running this)' },
    frontend: { type: 'enum', options: ['inertia', 'next'], description: 'inertia (React pages served by the app, the default) or next (a Next.js app with Caldera at /api)' },
    install: { type: 'boolean', description: 'Install dependencies (use --no-install to skip)' },
    git: { type: 'boolean', description: 'Create a git repository (use --no-git to skip)', default: true },
    json: { type: 'boolean', description: 'Print machine-readable JSON (default when output is not a terminal)' },
    link: { type: 'string', description: 'Development: use @caldera/* packages from a local checkout' },
  },
  async run({ args }) {
    const json = args.json ?? !process.stdout.isTTY
    // A person at a terminal is asked for what's missing and sees progress; CI and agents get
    // defaults and plain (or JSON) output instead.
    const interactive = !json && isInteractive()
    const given = {
      ...(args.directory ? { directory: args.directory as string } : {}),
      ...(args.pm ? { packageManager: args.pm as PackageManager } : {}),
      ...(args.frontend ? { frontend: args.frontend as Frontend } : {}),
      ...(args.install !== undefined ? { install: args.install as boolean } : {}),
    }
    try {
      if (interactive) intro(' create-caldera ')
      const chosen = interactive ? await askCreateOptions(clackPrompter(), given) : given
      const options: CreateOptions = {
        directory: chosen.directory ?? 'my-caldera-app',
        install: chosen.install ?? true,
        git: args.git,
        ...(chosen.packageManager ? { packageManager: chosen.packageManager } : {}),
        ...(chosen.frontend ? { frontend: chosen.frontend } : {}),
        ...(args.link ? { link: args.link } : {}),
      }
      if (!interactive) {
        const result = await createProject(options)
        return void process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${plain(result)}\n`)
      }
      const progress = spinner()
      // A step can run several commands (the database: generate, then migrate), each reported as
      // running; the spinner starts once per step (starting a running one would leave it spinning).
      let spinning: Step['name'] | undefined
      const result = await createProject({
        ...options,
        onStep: ({ name, status }) => {
          if (status === 'running') {
            if (spinning !== name) progress.start(RUNNING[name])
            spinning = name
            return
          }
          if (name === 'files') return void log.success(DONE[name])
          spinning = undefined
          if (status === 'done') progress.stop(DONE[name])
          else progress.error(`${RUNNING[name]} failed (see .create.log); finish it with the commands below`)
        },
      })
      note(result.next.join('\n'), 'Next')
      outro(`${result.name} is ready (${result.frontend === 'next' ? 'Next.js' : 'Inertia'}).`)
    } catch (error) {
      if (error instanceof PromptCancelled) {
        cancel('Cancelled: nothing was created.')
        process.exitCode = 1
        return
      }
      const body =
        error instanceof CreateError
          ? { code: error.code, message: error.message, details: error.details }
          : { code: 'internal_error', message: (error as Error).message }
      if (json) process.stdout.write(`${JSON.stringify({ error: body }, null, 2)}\n`)
      else if (interactive) cancel(body.message)
      else process.stderr.write(`✘ ${body.message}\n`)
      process.exitCode = 1
    }
  },
})

/** The summary without a terminal UI (piped output, CI). */
function plain(result: CreateResult): string {
  const icon = { done: '✓', skipped: '-', failed: '✘' } as const
  return [
    `Created ${result.name} (${result.frontend === 'next' ? 'Next.js' : 'Inertia'}) in ${result.directory}`,
    ...result.steps.map((s) => `  ${icon[s.status]} ${s.name}${s.status === 'failed' ? ` (see .create.log)` : ''}`),
    '',
    'Next:',
    ...result.next.map((command) => `  ${command}`),
  ].join('\n')
}

export function runCli() {
  return runMain(main)
}
