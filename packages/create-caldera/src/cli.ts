import { defineCommand, runMain } from 'citty'
import { createProject, CreateError, type PackageManager } from './create.js'

const main = defineCommand({
  meta: { name: 'create-caldera', description: 'Create a Caldera app' },
  args: {
    directory: { type: 'positional', description: 'Folder to create', required: false, default: 'my-caldera-app' },
    pm: { type: 'enum', options: ['pnpm', 'npm', 'yarn', 'bun'], description: 'Package manager (default: the one running this)' },
    install: { type: 'boolean', description: 'Install dependencies (use --no-install to skip)', default: true },
    git: { type: 'boolean', description: 'Create a git repository (use --no-git to skip)', default: true },
    json: { type: 'boolean', description: 'Print machine-readable JSON (default when output is not a terminal)' },
    link: { type: 'string', description: 'Development: use @caldera/* packages from a local checkout' },
  },
  run({ args }) {
    const json = args.json ?? !process.stdout.isTTY
    try {
      const result = createProject({
        directory: args.directory,
        install: args.install,
        git: args.git,
        ...(args.pm ? { packageManager: args.pm as PackageManager } : {}),
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
