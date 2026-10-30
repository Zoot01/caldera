import { defineCommand, runMain } from 'citty'
import { askCreateOptions } from './ask.js'
import { createProject, CreateError, type PackageManager } from './create.js'
import { isInteractive, readlinePrompter } from './prompt.js'

const main = defineCommand({
  meta: { name: 'create-caldera', description: 'Create a Caldera app' },
  args: {
    directory: { type: 'positional', description: 'Folder to create (asked for in a terminal; default my-caldera-app)', required: false },
    pm: { type: 'enum', options: ['pnpm', 'npm', 'yarn', 'bun'], description: 'Package manager (default: the one running this)' },
    install: { type: 'boolean', description: 'Install dependencies (use --no-install to skip)' },
    git: { type: 'boolean', description: 'Create a git repository (use --no-git to skip)', default: true },
    json: { type: 'boolean', description: 'Print machine-readable JSON (default when output is not a terminal)' },
    link: { type: 'string', description: 'Development: use @caldera/* packages from a local checkout' },
  },
  async run({ args }) {
    const json = args.json ?? !process.stdout.isTTY
    try {
      const given = {
        ...(args.directory ? { directory: args.directory as string } : {}),
        ...(args.pm ? { packageManager: args.pm as PackageManager } : {}),
        ...(args.install !== undefined ? { install: args.install as boolean } : {}),
      }
      // A person at a terminal is asked for what's missing; CI and agents get defaults instead.
      const chosen = !json && isInteractive() ? await askCreateOptions(readlinePrompter(), given) : given
      const result = createProject({
        directory: chosen.directory ?? 'my-caldera-app',
        install: chosen.install ?? true,
        git: args.git,
        ...(chosen.packageManager ? { packageManager: chosen.packageManager } : {}),
        ...(args.link ? { link: args.link } : {}),
      })
      if (json) return void process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      const icon = { done: '✓', skipped: '-', failed: '✘' } as const
      const lines = [
        `Created ${result.name} in ${result.directory}`,
        ...result.steps.map((s) => `  ${icon[s.status]} ${s.name}${s.status === 'failed' ? ` (see .create.log)` : ''}`),
        '',
        'Next:',
        ...result.next.map((command) => `  ${command}`),
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
    } catch (error) {
      const body =
        error instanceof CreateError
          ? { code: error.code, message: error.message, details: error.details }
          : { code: 'internal_error', message: (error as Error).message }
      if (json) process.stdout.write(`${JSON.stringify({ error: body }, null, 2)}\n`)
      else process.stderr.write(`✘ ${body.message}\n`)
      process.exitCode = 1
    }
  },
})

export function runCli() {
  return runMain(main)
}
