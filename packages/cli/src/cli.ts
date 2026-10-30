import { CalderaError } from '@caldera/core'
import { defineCommand, runMain } from 'citty'
import { generate } from './codegen.js'
import { describeProject } from './describe.js'
import { openProject } from './project.js'

const VERSION = '0.0.0'

const shared = {
  cwd: { type: 'string', description: 'Project root', default: '.' },
  json: { type: 'boolean', description: 'Print machine-readable JSON (default when output is not a terminal)' },
} as const

/** JSON when asked for, and by default when piped or run by an agent, so tools never parse prose. */
function wantsJson(flag: boolean | undefined): boolean {
  return flag ?? !process.stdout.isTTY
}

async function run(json: boolean, task: () => Promise<{ data: unknown; text: string; exitCode?: number }>) {
  try {
    const { data, text, exitCode } = await task()
    process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`)
    if (exitCode) process.exitCode = exitCode
  } catch (error) {
    const body =
      error instanceof CalderaError
        ? error.toJSON()
        : { name: 'Error', code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
    if (json) process.stdout.write(`${JSON.stringify({ error: body }, null, 2)}\n`)
    else process.stderr.write(`✘ ${body.message}\n`)
    process.exitCode = 1
  }
}

const generateCommand = defineCommand({
  meta: { name: 'generate', description: 'Write the typed registries in .caldera/ from your env and config files' },
  args: {
    ...shared,
    check: { type: 'boolean', description: 'Exit with code 1 if generated files are out of date, without writing' },
  },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = await generate(openProject(args.cwd), { check: args.check })
      const lines = result.files.map((f) => `${f.status.padEnd(9)} ${f.path}`)
      const summary = result.stale ? 'Generated files are out of date. Run `caldera generate`.' : 'Generated files are up to date.'
      return { data: { schemaVersion: 1, ...result }, text: [...lines, summary].join('\n'), exitCode: result.stale ? 1 : 0 }
    }),
})

const describeCommand = defineCommand({
  meta: { name: 'describe', description: 'Describe the app: env schema, config (secrets redacted), providers and services' },
  args: {
    ...shared,
    boot: { type: 'boolean', description: 'Boot the app with .env to include config values', default: true },
  },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const description = await describeProject(openProject(args.cwd), { boot: args.boot })
      const text = [
        `state      ${description.state}`,
        `env        ${description.env.keys.map((k) => `${k.name}${k.secret ? '*' : ''}`).join(', ')}`,
        `config     ${description.config ? Object.keys(description.config).join(', ') : '(not booted)'}`,
        ...description.providers.map(
          (p) => `provider   ${p.name}: ${p.services.map((s) => `${s.name} (${s.lifetime})`).join(', ') || 'no services'}`,
        ),
      ].join('\n')
      return { data: description, text }
    }),
})

export const main = defineCommand({
  meta: { name: 'caldera', version: VERSION, description: 'Caldera framework CLI' },
  subCommands: { generate: generateCommand, describe: describeCommand },
})

export function runCli() {
  return runMain(main)
}
