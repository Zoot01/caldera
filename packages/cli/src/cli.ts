import { CalderaError } from '@caldera/core'
import { defineCommand, runMain } from 'citty'
import { generate } from './codegen.js'
import { describeProject } from './describe.js'
import { openProject } from './project.js'
import { listRoutes } from './routes.js'
import { runMigrations, type MigrationCommand } from './migrations.js'
import { describeModel, describeSchema } from './schema.js'
import { seedProject } from './seed.js'

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

const routeListCommand = defineCommand({
  meta: { name: 'route:list', description: 'List every route with its name, middleware and input schemas' },
  args: shared,
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const manifest = await listRoutes(openProject(args.cwd))
      const rows = manifest.routes.map((r) => [r.method, r.path, r.name, r.middleware.map((m) => m.name).join(', ')])
      const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i]!.length), 6))
      const text = rows.length
        ? rows.map((row) => row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]!) : cell)).join('  ')).join('\n')
        : 'No routes found in src/routes.'
      return { data: manifest, text }
    }),
})

const modelShowCommand = defineCommand({
  meta: { name: 'model:show', description: 'Show a model: columns (hidden/guarded), relations, scopes, hooks and route key' },
  args: { name: { type: 'positional', description: 'Model name or relations key', required: true }, ...shared },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const model = await describeModel(openProject(args.cwd), args.name)
      const flags = (c: { primary: boolean; hidden: boolean; guarded: boolean; nullable: boolean }) =>
        [c.primary && 'primary', c.hidden && 'hidden', c.guarded && 'guarded', c.nullable && 'nullable'].filter(Boolean).join(', ')
      const text = [
        `${model.name}  (${model.table}, ${model.file})`,
        ...model.columns.map((c) => `  ${c.name.padEnd(16)} ${c.type.padEnd(26)} ${flags(c)}`),
        ...model.relations.map((r) => `  ${r.name.padEnd(16)} ${r.type} → ${r.model ?? r.target}`),
      ].join('\n')
      return { data: model, text }
    }),
})

const dbSchemaCommand = defineCommand({
  meta: { name: 'db:schema', description: 'Describe every table: columns, relations and models' },
  args: shared,
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const schema = await describeSchema(openProject(args.cwd))
      const text = schema.tables.length
        ? schema.tables
            .map((t) => `${t.table}${t.model ? ` (model ${t.model})` : ''}: ${t.columns.map((c) => c.column).join(', ')}`)
            .join('\n')
        : 'No tables found in src/db/relations.ts.'
      return { data: schema, text }
    }),
})

function migrationCommand(command: MigrationCommand, description: string) {
  return defineCommand({
    meta: { name: `db:${command}`, description },
    args: { ...shared, force: { type: 'boolean', description: 'Allow running against a production database' } },
    run: ({ args, rawArgs }) =>
      run(wantsJson(args.json), async () => {
        // Anything after `--` goes to drizzle-kit unchanged.
        const separator = rawArgs.indexOf('--')
        const extraArgs = separator >= 0 ? rawArgs.slice(separator + 1) : []
        const json = wantsJson(args.json)
        const result = runMigrations(openProject(args.cwd), command, { force: args.force, capture: json, extraArgs })
        return { data: { schemaVersion: 1, ...result }, text: result.exitCode === 0 ? `✓ db:${command} finished` : `✘ db:${command} failed`, exitCode: result.exitCode }
      }),
  })
}

const dbSeedCommand = defineCommand({
  meta: { name: 'db:seed', description: 'Run the seeders in src/db/seeders (dependencies first, in one transaction)' },
  args: {
    ...shared,
    seed: { type: 'string', description: 'Faker seed, to reproduce the same data' },
    only: { type: 'string', description: 'Comma-separated seeder names to run (plus their dependencies)' },
    force: { type: 'boolean', description: 'Allow seeding production (only seeders marked production: true run)' },
  },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const report = await seedProject(openProject(args.cwd), {
        force: args.force,
        seed: args.seed === undefined ? undefined : Number(args.seed),
        only: args.only?.split(',').map((s) => s.trim()).filter(Boolean),
      })
      const text = [
        ...report.seeders.map((s) => (s.status === 'ran' ? `✓ ${s.name} (${s.ms}ms)` : `- ${s.name} skipped: ${s.reason}`)),
        `seed ${report.seed} (rerun with --seed=${report.seed} for the same data)`,
      ].join('\n')
      return { data: report, text }
    }),
})

export const main = defineCommand({
  meta: { name: 'caldera', version: VERSION, description: 'Caldera framework CLI' },
  subCommands: {
    generate: generateCommand,
    describe: describeCommand,
    'route:list': routeListCommand,
    'model:show': modelShowCommand,
    'db:schema': dbSchemaCommand,
    'db:generate': migrationCommand('generate', 'Generate SQL migrations from your Drizzle schema (drizzle-kit generate)'),
    'db:migrate': migrationCommand('migrate', 'Apply pending migrations (drizzle-kit migrate)'),
    'db:seed': dbSeedCommand,
    'db:push': migrationCommand('push', 'Push the schema straight to the database, for prototyping (drizzle-kit push)'),
  },
})

export function runCli() {
  return runMain(main)
}
