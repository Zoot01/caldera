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
import { check } from './check.js'
import { startDev } from './dev.js'
import { failedJobs, queueTable, startWorker } from './queue.js'
import { cacheTable, notificationsTable } from './notifications.js'
import { cloudflareSetup, d1Migrations } from './cloudflare.js'
import { vercelBuild, vercelSetup } from './vercel.js'
import { i18nReport } from './i18n.js'
import { createMcpServer, serveStdio } from './mcp/protocol.js'
import { calderaTools, INSTRUCTIONS } from './mcp/tools.js'
import { bootScheduler, listSchedules, startScheduleWorker, syncSchedules } from './schedule.js'

const VERSION = '0.0.0'

const shared = {
  cwd: { type: 'string', description: 'Project root', default: '.' },
  json: { type: 'boolean', description: 'Print machine-readable JSON (default when output is not a terminal)' },
} as const

function isCalderaError(error: unknown): error is CalderaError {
  return error instanceof Error && typeof (error as CalderaError).code === 'string' && typeof (error as CalderaError).toJSON === 'function'
}

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
    // By shape, not instanceof: the project's code runs in its own module graph with its own copy
    // of @caldera/core, so its errors aren't instances of the CLI's CalderaError class.
    const body =
      isCalderaError(error)
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
  page: 'Create an Inertia page in resources/pages/ (e.g. Posts/Index)',
  job: 'Create a queued job in src/jobs/',
  event: 'Create an event in src/events/',
  listener: 'Create an event listener in src/listeners/ (needs --event)',
  schedule: 'Create a schedule in src/schedules/ (needs --job)',
  mail: 'Create a mail (React Email) in src/mail/',
  notification: 'Create a notification in src/notifications/',
}

function makeCommand(kind: MakeKind) {
  return defineCommand({
    meta: { name: `make:${kind}`, description: DESCRIPTIONS[kind] },
    args: {
      name: { type: 'positional', description: 'Name, e.g. BlogPost or blog-post', required: false },
      ...shared,
      force: { type: 'boolean', description: 'Overwrite existing files' },
      ...(kind === 'model' ? { table: { type: 'boolean', description: 'Also create the table (use --no-table for an existing one)', default: true } } : {}),
      ...(kind === 'listener' ? { event: { type: 'string', description: 'The event it listens to, e.g. UserRegistered' } } : {}),
      ...(kind === 'schedule' ? { job: { type: 'string', description: 'The job it dispatches, e.g. GenerateReport' } } : {}),
    },
    run: ({ args }) =>
      run(wantsJson(args.json), async () => {
        const name = requireArg(args.name as string | undefined, 'name', `Usage: caldera make:${kind} <name>`)
        const result = await make(openProject(args.cwd), kind, name, { force: args.force, table: (args as { table?: boolean }).table, event: (args as { event?: string }).event, job: (args as { job?: string }).job })
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

const checkCommand = defineCommand({
  meta: { name: 'check', description: 'Fail (exit 1) if generated types, AGENTS.md or the auth schema are out of date, or the app is misconfigured' },
  args: shared,
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = await check(openProject(args.cwd))
      const text = result.ok
        ? '✓ Everything is up to date.'
        : result.issues.map((i) => `✘ ${i.message}${i.fix ? `  (fix: ${i.fix})` : ''}`).join('\n')
      return { data: result, text, exitCode: result.ok ? 0 : 1 }
    }),
})

const queueWorkCommand = defineCommand({
  meta: { name: 'queue:work', description: 'Process queued jobs (BullMQ and other drivers with workers) until stopped' },
  args: {
    ...shared,
    queue: { type: 'string', description: 'Comma-separated queues to consume, in order (default: default)' },
    concurrency: { type: 'string', description: 'Jobs handled at once (default 1)' },
    connection: { type: 'string', description: 'Queue connection (default: the default one)' },
  },
  async run({ args }) {
    const json = wantsJson(args.json)
    // One line per event: JSON for agents and log collectors, short text in a terminal.
    const print = (event: import('./queue.js').WorkerEvent) => {
      if (json) return void process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
      if (event.type === 'started') process.stdout.write(`Processing jobs: ${event.jobs?.join(', ') || '(none found in src/jobs)'}\n`)
      else if (event.type === 'stopped') process.stdout.write('Worker stopped.\n')
      else {
        const mark = event.status === 'done' ? '✓' : event.status === 'retry' ? '↻' : '✘'
        const detail = event.status === 'retry' ? ` retry in ${event.delaySeconds}s: ${event.error}` : event.status === 'failed' ? ` ${event.error}` : ''
        process.stdout.write(`${mark} ${event.job} #${event.attempt}${detail}\n`)
      }
    }
    try {
      const worker = await startWorker(openProject(args.cwd), {
        ...(args.queue ? { queues: args.queue.split(',').map((q) => q.trim()).filter(Boolean) } : {}),
        ...(args.concurrency ? { concurrency: Number(args.concurrency) } : {}),
        ...(args.connection ? { connection: args.connection } : {}),
        onEvent: print,
      })
      await new Promise<void>((resolve) => {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void worker.stop().then(resolve))
      })
    } catch (error) {
      await run(json, async () => {
        throw error
      })
    }
  },
})

const queueTableCommand = defineCommand({
  meta: { name: 'queue:table', description: 'Create the database queue table in src/db/tables (for the database driver)' },
  args: { ...shared, force: { type: 'boolean', description: 'Overwrite an existing file' } },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = queueTable(openProject(args.cwd), { force: args.force })
      return { data: result, text: [...result.created.map((p) => `created   ${p}`), ...result.hints.map((h) => `next      ${h}`)].join('\n') }
    }),
})

const notificationsTableCommand = defineCommand({
  meta: { name: 'notifications:table', description: 'Create the notifications table in src/db/tables (for the database channel)' },
  args: { ...shared, force: { type: 'boolean', description: 'Overwrite an existing file' } },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = notificationsTable(openProject(args.cwd), { force: args.force })
      return { data: result, text: [...result.created.map((p) => `created   ${p}`), ...result.hints.map((h) => `next      ${h}`)].join('\n') }
    }),
})

const cacheTableCommand = defineCommand({
  meta: { name: 'cache:table', description: 'Create the cache table in src/db/tables (for the database cache store)' },
  args: { ...shared, force: { type: 'boolean', description: 'Overwrite an existing file' } },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = cacheTable(openProject(args.cwd), { force: args.force })
      return { data: result, text: [...result.created.map((p) => `created   ${p}`), ...result.hints.map((h) => `next      ${h}`)].join('\n') }
    }),
})

const cloudflareSetupCommand = defineCommand({
  meta: { name: 'cloudflare:setup', description: 'Add wrangler.json and src/worker.ts to run this app on Cloudflare Workers (D1, R2, Queues, Email, Cron)' },
  args: { ...shared, force: { type: 'boolean', description: 'Overwrite existing files' } },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = await cloudflareSetup(openProject(args.cwd), { force: args.force })
      return { data: result, text: [...result.created.map((p) => `created   ${p}`), ...result.hints.map((h) => `next      ${h}`)].join('\n') }
    }),
})

const vercelSetupCommand = defineCommand({
  meta: { name: 'vercel:setup', description: 'Add vercel.json and api/index.ts to deploy this app to Vercel (Node.js runtime)' },
  args: { ...shared, force: { type: 'boolean', description: 'Overwrite existing files' } },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = vercelSetup(openProject(args.cwd), { force: args.force })
      return { data: result, text: [...result.created.map((p) => `created   ${p}`), ...result.hints.map((h) => `next      ${h}`)].join('\n') }
    }),
})

const vercelBuildCommand = defineCommand({
  meta: { name: 'vercel:build', description: 'Generate, then bundle the app for api/index.js (vercel.json\'s buildCommand)' },
  args: { ...shared },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const project = openProject(args.cwd)
      const result = await vercelBuild(project, () => generate(project))
      return { data: result, text: `bundled   ${result.bundle} (${result.modules} modules)` }
    }),
})

const d1MigrationsCommand = defineCommand({
  meta: { name: 'd1:migrations', description: 'Copy drizzle migrations to migrations/ for `wrangler d1 migrations apply`' },
  args: { ...shared },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = d1Migrations(openProject(args.cwd))
      return { data: result, text: [...result.copied.map((p) => `copied    ${p}`), ...result.unchanged.map((p) => `unchanged ${p}`), ...result.hints.map((h) => `next      ${h}`)].join('\n') }
    }),
})

const i18nMissingCommand = defineCommand({
  meta: { name: 'i18n:missing', description: 'Report missing, extra and mismatched translations per locale, and unused keys' },
  args: { ...shared },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const report = i18nReport(openProject(args.cwd))
      const lines = [`canonical ${report.canonical} (${report.total} messages)`]
      for (const l of report.locales) {
        lines.push(`${l.locale.padEnd(9)} ${l.missing.length} missing, ${l.extra.length} extra, ${l.mismatched.length} mismatched`)
        for (const key of l.missing) lines.push(`  missing    ${key}`)
        for (const key of l.extra) lines.push(`  extra      ${key}`)
        for (const m of l.mismatched) lines.push(`  mismatch   ${m.key} (${m.file}): ${m.problems.join('; ')}`)
      }
      for (const key of report.unused) lines.push(`unused     ${key}`)
      for (const p of report.unknownPagePatterns) lines.push(`unknown    ${p.page} declares "${p.pattern}"`)
      return { data: report, text: lines.join('\n') }
    }),
})

const mcpCommand = defineCommand({
  meta: { name: 'mcp', description: 'Serve the app to coding agents over MCP (stdio): introspection, logs, errors, read-only SQL, in-process requests' },
  args: {
    cwd: shared.cwd,
    'allow-writes': { type: 'boolean', description: 'Also allow tools that change things: non-GET requests, make, db_seed' },
  },
  run: async ({ args }) => {
    const probe = openProject(args.cwd)
    const root = probe.root
    await probe.dispose()
    // The app resolves relative paths (file:local.db, storage/app, its tsconfig) from where it runs.
    process.chdir(root)
    const server = createMcpServer({ name: 'caldera', version: VERSION, instructions: INSTRUCTIONS, tools: calderaTools({ root, allowWrites: Boolean(args['allow-writes']) }) })
    await serveStdio(server)
  },
})

const queueFailedCommand = defineCommand({
  meta: { name: 'queue:failed', description: 'List failed jobs (database queue driver)' },
  args: { ...shared, connection: { type: 'string', description: 'Queue connection (default: the default one)' } },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const { driver, shutdown } = await failedJobs(openProject(args.cwd), args.connection)
      try {
        const jobs = await driver.failed()
        const text = jobs.map((j) => `${j.failedAt}  ${j.id}  ${j.job} (${j.queue}, ${j.attempts} attempts): ${j.error ?? ''}`).join('\n')
        return { data: { schemaVersion: 1, jobs }, text: text || 'No failed jobs.' }
      } finally {
        await shutdown()
      }
    }),
})

function failedJobsAction(name: 'retry' | 'forget', description: string) {
  return defineCommand({
    meta: { name: `queue:${name}`, description },
    args: {
      ...shared,
      ids: { type: 'positional', description: 'Failed job ids (from queue:failed)', required: false },
      all: { type: 'boolean', description: 'Every failed job' },
      connection: { type: 'string', description: 'Queue connection (default: the default one)' },
    },
    run: ({ args }) =>
      run(wantsJson(args.json), async () => {
        const ids = (args._ as string[] | undefined)?.filter(Boolean) ?? []
        if (!args.all && ids.length === 0) throw new CalderaError('missing_argument', `Pass job ids or --all. Usage: caldera queue:${name} <id...> | --all`, { missing: ['ids'] })
        const { driver, shutdown } = await failedJobs(openProject(args.cwd), args.connection)
        try {
          const count = await driver[name](args.all ? undefined : ids)
          return { data: { schemaVersion: 1, [name === 'retry' ? 'retried' : 'forgotten']: count }, text: `${name === 'retry' ? 'Queued again' : 'Deleted'}: ${count} job${count === 1 ? '' : 's'}.` }
        } finally {
          await shutdown()
        }
      }),
  })
}

const scheduleListCommand = defineCommand({
  meta: { name: 'schedule:list', description: 'List schedules in src/schedules with their next run' },
  args: shared,
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const data = await listSchedules(openProject(args.cwd))
      const text = data.schedules.map((s) => `${s.name.padEnd(24)} ${`${s.cron}${s.tz === 'UTC' ? '' : ` ${s.tz}`}`.padEnd(24)} → ${s.job.padEnd(20)} next ${s.next ?? 'never'}`).join('\n')
      return { data, text: text || 'No schedules in src/schedules.' }
    }),
})

const scheduleRunCommand = defineCommand({
  meta: { name: 'schedule:run', description: 'Dispatch the schedules due this minute, once (for an OS crontab: * * * * *)' },
  args: shared,
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const { scheduler, shutdown } = await bootScheduler(openProject(args.cwd))
      try {
        const result = await scheduler.runDue()
        const text = result.results.map((r) => `${r.status === 'dispatched' ? '✓' : '-'} ${r.name}${r.reason ? ` (${r.reason})` : ''}`).join('\n')
        return { data: { schemaVersion: 1, ...result }, text: text || `Nothing due at ${result.minute}.` }
      } finally {
        await shutdown()
      }
    }),
})

const scheduleWorkCommand = defineCommand({
  meta: { name: 'schedule:work', description: 'Dispatch due schedules every minute until stopped' },
  args: shared,
  async run({ args }) {
    const json = wantsJson(args.json)
    try {
      const worker = await startScheduleWorker(openProject(args.cwd), (tick) => {
        if (json) return void process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...tick })}\n`)
        for (const r of tick.results) process.stdout.write(`${tick.minute} ${r.status === 'dispatched' ? '✓' : '-'} ${r.name}${r.reason ? ` (${r.reason})` : ''}\n`)
      })
      if (!json) process.stdout.write('Running schedules every minute. Ctrl+C to stop.\n')
      await new Promise<void>((resolve) => {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void worker.stop().then(resolve))
      })
    } catch (error) {
      await run(json, async () => {
        throw error
      })
    }
  },
})

const scheduleSyncCommand = defineCommand({
  meta: { name: 'schedule:sync', description: 'Write platform cron entries (vercel.json or wrangler.toml) from src/schedules' },
  args: {
    ...shared,
    target: { type: 'enum', options: ['vercel', 'cloudflare'], description: 'Platform', required: true },
    check: { type: 'boolean', description: 'Exit with code 1 if the file is out of date, without writing' },
  },
  run: ({ args }) =>
    run(wantsJson(args.json), async () => {
      const result = await syncSchedules(openProject(args.cwd), args.target as 'vercel' | 'cloudflare', { check: args.check })
      const text = [`${result.status.padEnd(9)} ${result.file} (${result.crons.length} cron${result.crons.length === 1 ? '' : 's'})`, ...result.warnings.map((w) => `warning   ${w}`)].join('\n')
      return { data: result, text, exitCode: result.status === 'stale' ? 1 : 0 }
    }),
})

const devCommand = defineCommand({
  meta: { name: 'dev', description: 'Run the app (tsx watch) and Vite, and keep generated types current as you edit' },
  args: {
    cwd: shared.cwd,
    server: { type: 'boolean', description: 'Start the server (use --no-server to only regenerate types)', default: true },
    vite: { type: 'boolean', description: 'Start the Vite dev server when there is a vite.config (use --no-vite to skip)', default: true },
    entry: { type: 'string', description: 'Server entry file', default: 'src/server.ts' },
  },
  async run({ args }) {
    const session = startDev(openProject(args.cwd).root, {
      server: args.server,
      vite: args.vite,
      serverEntry: args.entry,
      onEvent: (event) => {
        if (event.type === 'error') process.stderr.write(`✘ caldera generate: ${event.error}\n`)
        else if (event.changed.length) process.stdout.write(`↻ regenerated ${event.changed.join(', ')}\n`)
      },
    })
    await session.ready
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void session.stop().then(resolve))
    })
  },
})

export const main = defineCommand({
  meta: { name: 'caldera', version: VERSION, description: 'Caldera framework CLI' },
  subCommands: {
    generate: generateCommand,
    check: checkCommand,
    dev: devCommand,
    'queue:work': queueWorkCommand,
    'queue:table': queueTableCommand,
    'queue:failed': queueFailedCommand,
    'queue:retry': failedJobsAction('retry', 'Put failed jobs back on their queue (database queue driver)'),
    'queue:forget': failedJobsAction('forget', 'Delete failed jobs (database queue driver)'),
    'notifications:table': notificationsTableCommand,
    'cache:table': cacheTableCommand,
    'cloudflare:setup': cloudflareSetupCommand,
    'd1:migrations': d1MigrationsCommand,
    'vercel:setup': vercelSetupCommand,
    'vercel:build': vercelBuildCommand,
    'i18n:missing': i18nMissingCommand,
    mcp: mcpCommand,
    'schedule:list': scheduleListCommand,
    'schedule:run': scheduleRunCommand,
    'schedule:work': scheduleWorkCommand,
    'schedule:sync': scheduleSyncCommand,
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
