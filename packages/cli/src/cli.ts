import { CalderaError } from '@caldera/core'
import { defineCommand, runMain } from 'citty'
import { generate } from './codegen.js'
import { describeProject } from './describe.js'
import { openProject } from './project.js'
import { listRoutes } from './routes.js'
import { runMigrations, type MigrationCommand } from './migrations.js'
import { describeModel, describeSchema } from './schema.js'
import { seedProject } from './seed.js'
import { describeAbilities } from './policies.js'
import { generateProjectAuthSchema } from './auth-schema.js'
import { ejectStub, make, MAKE_KINDS, type MakeKind } from './make.js'
import { STUBS } from './stubs.js'

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
    // 2 = the command was called wrong (agents can fix the call); 1 = it ran and failed.
    process.exitCode = body.code === 'missing_argument' ? 2 : 1
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

const abilitiesCommand = defineCommand({
  meta: { name: 'abilities', description: 'List every policy ability and standalone ability, with the routes each one guards' },
  args: shared,
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const data = await describeAbilities(openProject(args.cwd))
      const text = [
        ...data.policies.flatMap((p) =>
          p.abilities.map((a) => `${a.name.padEnd(24)} ${a.guest ? 'guests ok' : 'signed in'}${a.routes.length ? `  ← ${a.routes.join(', ')}` : ''}`),
        ),
        ...data.abilities.map((a) => `${a.name.padEnd(24)} ${a.guest ? 'guests ok' : 'signed in'}  (standalone)`),
      ].join('\n')
      return { data, text: text || 'No policies found in src/policies.' }
    }),
})

const authSchemaCommand = defineCommand({
  meta: { name: 'auth:schema', description: 'Write Drizzle tables for your Better Auth config (incl. plugins) to src/db/auth-schema.ts' },
  args: {
    ...shared,
    check: { type: 'boolean', description: 'Exit with code 1 if the file is out of date, without writing' },
    dialect: { type: 'enum', options: ['pg', 'sqlite'], description: 'SQL dialect (default: from the database driver)' },
  },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = await generateProjectAuthSchema(openProject(args.cwd), { check: args.check, dialect: args.dialect as 'pg' | 'sqlite' | undefined })
      const text = [
        `${result.status.padEnd(9)} ${result.file} (${result.tables.join(', ')})`,
        ...result.userFields.map((f) => `add to your users table: ${f.name} (${f.type}${f.required ? ', required' : ''})`),
      ].join('\n')
      return { data: result, text, exitCode: result.status === 'stale' ? 1 : 0 }
    }),
})

function requireArg(value: string | undefined, name: string, hint: string): string {
  if (value && value.trim()) return value
  throw new CalderaError('missing_argument', `Missing <${name}>. ${hint}`, { missing: [name] })
}

const DESCRIPTIONS: Record<MakeKind, string> = {
  model: 'Create a model (and its table in src/db/tables/)',
  policy: 'Create a policy in src/policies/',
  factory: 'Create a factory in src/db/factories/',
  seeder: 'Create a seeder in src/db/seeders/',
  routes: 'Create a route group in src/routes/',
  config: 'Create a config file in src/config/',
  provider: 'Create a provider in src/providers/',
}

function makeCommand(kind: MakeKind) {
  return defineCommand({
    meta: { name: `make:${kind}`, description: DESCRIPTIONS[kind] },
    args: {
      name: { type: 'positional', description: 'Name, e.g. BlogPost or blog-post', required: false },
      ...shared,
      force: { type: 'boolean', description: 'Overwrite existing files' },
      ...(kind === 'model' ? { table: { type: 'boolean', description: 'Also create the table (use --no-table for an existing one)', default: true } } : {}),
    },
    run: ({ args }) =>
      run(wantsJson(args.json), async () => {
        const name = requireArg(args.name as string | undefined, 'name', `Usage: caldera make:${kind} <name>`)
        const result = await make(openProject(args.cwd), kind, name, { force: args.force, table: (args as { table?: boolean }).table })
        const text = [
          ...result.created.map((path) => `created   ${path}`),
          ...result.hints.map((hint) => `next      ${hint}`),
          ...(typeof result.generate === 'object' ? [`note      caldera generate didn't finish: ${result.generate.error}`] : []),
        ].join('\n')
        return { data: result, text }
      }),
  })
}

const stubEjectCommand = defineCommand({
  meta: { name: 'stub:eject', description: 'Copy a built-in stub to stubs/ so generators use your version' },
  args: {
    stub: { type: 'positional', description: `One of: ${Object.keys(STUBS).join(', ')}`, required: false },
    ...shared,
    force: { type: 'boolean', description: 'Overwrite an existing stub' },
  },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const stub = requireArg(args.stub as string | undefined, 'stub', `One of: ${Object.keys(STUBS).join(', ')}`)
      const result = ejectStub(openProject(args.cwd), stub, { force: args.force })
      return { data: result, text: result.created.map((p) => `created   ${p}`).join('\n') }
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
    abilities: abilitiesCommand,
    'auth:schema': authSchemaCommand,
    ...Object.fromEntries(MAKE_KINDS.map((kind) => [`make:${kind}`, makeCommand(kind)])),
    'stub:eject': stubEjectCommand,
    'db:push': migrationCommand('push', 'Push the schema straight to the database, for prototyping (drizzle-kit push)'),
  },
})

export function runCli() {
  return runMain(main)
}
