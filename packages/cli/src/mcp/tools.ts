import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CalderaError } from '@caldera/core'
import { z } from 'zod'
import { describeAbilities } from '../policies.js'
import { check } from '../check.js'
import { generate } from '../codegen.js'
import { describeProject, loadApp, projectEnv } from '../describe.js'
import { i18nReport } from '../i18n.js'
import { make, MAKE_KINDS } from '../make.js'
import { loadMails } from '../mails.js'
import { CONVENTIONS, openProject, type Project } from '../project.js'
import { listRoutes } from '../routes.js'
import { listSchedules } from '../schedule.js'
import { describeModel, describeSchema } from '../schema.js'
import { seedProject } from '../seed.js'
import { defineTool, type ToolDefinition } from './protocol.js'

export interface ToolOptions {
  root: string
  /** Tools that change files, the database or anything outside: off unless `caldera mcp --allow-writes`. */
  allowWrites: boolean
}

const MAX_BODY = 50_000

/** A fresh project load per call, so every call sees the code as it is now. */
async function withProject<T>(root: string, fn: (project: Project) => Promise<T>): Promise<T> {
  const project = openProject(root)
  try {
    return await fn(project)
  } finally {
    await project.dispose()
  }
}

/** Boots the app with the project's .env, runs `fn`, and shuts it down. */
async function withApp<T>(project: Project, fn: (app: Awaited<ReturnType<typeof loadApp>> & { services: Record<string, unknown> }) => Promise<T>): Promise<T> {
  const app = await loadApp(project)
  await app.boot({ env: projectEnv(project) })
  try {
    return await fn(app as never)
  } finally {
    await app.shutdown()
  }
}

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

function devFile(root: string, name: string): string {
  const file = join(root, CONVENTIONS.generatedDir, name)
  if (!existsSync(file)) throw new CalderaError('dev_not_running', `No ${CONVENTIONS.generatedDir}/${name}: start the app with \`caldera dev\` (it records the server's output and errors for this tool).`)
  return file
}

export function calderaTools({ root, allowWrites }: ToolOptions): ToolDefinition<any>[] {
  const read = { readOnlyHint: true, openWorldHint: false } as const
  const tools: ToolDefinition<any>[] = [
    defineTool({
      name: 'describe',
      title: 'Describe the app',
      description: 'The app as data: env keys (presence only, never values), redacted config, providers and the services they register, and manager instances with drivers and capabilities. Start here.',
      input: z.object({}),
      annotations: read,
      handle: () => withProject(root, (project) => describeProject(project)),
    }),
    defineTool({
      name: 'routes',
      title: 'List routes',
      description: 'Every route: name, method, path, middleware, the ability guarding it, input JSON Schemas, and the file:line that defines it.',
      input: z.object({ filter: z.string().optional().describe('Only routes whose name or path contains this') }),
      annotations: read,
      handle: ({ filter }) =>
        withProject(root, async (project) => {
          const { routes } = await listRoutes(project)
          return { routes: filter ? routes.filter((r) => `${r.name} ${r.path}`.includes(filter)) : routes }
        }),
    }),
    defineTool({
      name: 'db_schema',
      title: 'Database schema',
      description: 'Every table: columns (type, nullability, defaults), primary and foreign keys, and indexes, from the Drizzle schema.',
      input: z.object({}),
      annotations: read,
      handle: () => withProject(root, (project) => describeSchema(project)),
    }),
    defineTool({
      name: 'model',
      title: 'Show a model',
      description: 'One model: its table, columns, relations, hidden fields, casts and hooks.',
      input: z.object({ name: z.string().describe('Model name (e.g. "post") or relations key') }),
      annotations: read,
      handle: ({ name }) => withProject(root, (project) => describeModel(project, name)),
    }),
    defineTool({
      name: 'abilities',
      title: 'List abilities',
      description: 'Policies and abilities: whether guests may pass, and which routes each guards.',
      input: z.object({}),
      annotations: read,
      handle: () => withProject(root, (project) => describeAbilities(project)),
    }),
    defineTool({
      name: 'schedules',
      title: 'List schedules',
      description: 'Scheduled jobs: cron, time zone, next run, overlap and one-server settings.',
      input: z.object({}),
      annotations: read,
      handle: () => withProject(root, (project) => listSchedules(project)),
    }),
    defineTool({
      name: 'check',
      title: 'Check the project',
      description: 'What `caldera check` verifies: stale generated files or AGENTS.md, a stale auth schema, translations with mismatched parameters. Each issue has a code and the fixing command.',
      input: z.object({}),
      annotations: read,
      handle: () => withProject(root, (project) => check(project)),
    }),
    defineTool({
      name: 'generate',
      title: 'Regenerate types',
      description: 'Runs `caldera generate`: rewrites .caldera/ (types, route/job/listener lists) and the generated part of AGENTS.md. Only generated files change. Use after adding env, config, routes, models, pages or translations when `caldera dev` isn’t running.',
      input: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handle: () => withProject(root, (project) => generate(project)),
    }),
    defineTool({
      name: 'i18n_missing',
      title: 'Translation report',
      description: 'Per locale: missing, extra and mismatched-parameter messages; unused keys; page message patterns that match nothing.',
      input: z.object({}),
      annotations: read,
      handle: () => withProject(root, async (project) => i18nReport(project)),
    }),
    defineTool({
      name: 'mail_list',
      title: 'List mails',
      description: 'Every mail in src/mail: name, export, and whether it has preview props.',
      input: z.object({}),
      annotations: read,
      handle: () =>
        withProject(root, async (project) => ({ mails: (await loadMails(project)).map(({ mail, exportName, file }) => ({ name: mail.name, export: exportName, file, preview: mail.preview ?? null })) })),
    }),
    defineTool({
      name: 'mail_render',
      title: 'Render a mail',
      description: 'Renders a mail with the given props (default: its preview props) without sending it: subject, HTML, plain text and size.',
      input: z.object({ name: z.string().describe('The mail name, e.g. "users.welcome"'), props: z.record(z.string(), z.unknown()).optional() }),
      annotations: read,
      handle: ({ name, props }) =>
        withProject(root, (project) =>
          withApp(project, async (app) => {
            const mail = (app.services.mail as { find(name: string): { preview?: unknown } | undefined } | undefined)?.find(name)
            if (!mail) throw new CalderaError('mail_missing', `No mail named "${name}" (see mail_list).`)
            const { renderMail } = await project.importPackage<{ renderMail(mail: unknown, props: unknown): Promise<{ subject: string; html: string; text: string }> }>('@caldera/mail')
            const rendered = await renderMail(mail, props ?? mail.preview ?? {})
            return { subject: rendered.subject, text: rendered.text, html: rendered.html.slice(0, MAX_BODY), htmlBytes: new TextEncoder().encode(rendered.html).length }
          }),
        ),
    }),
    defineTool({
      name: 'mail_outbox',
      title: 'Mail sent in development',
      description: 'What the log mailer "sent" under `caldera dev`, from the server and from queue workers: subject, recipients, time. Pass an id for that message’s text and HTML.',
      input: z.object({ limit: z.number().int().min(1).max(200).default(20), id: z.string().optional() }),
      annotations: read,
      handle: async ({ limit, id }) => {
        const entries = readFileSync(devFile(root, 'mail-outbox.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { id: string; subject: string; html: string; text?: string; [key: string]: unknown })
        if (id) {
          const found = entries.find((m) => m.id === id)
          if (!found) throw new CalderaError('not_found', `No message ${id} in the outbox.`)
          return { ...found, html: found.html.slice(0, MAX_BODY) }
        }
        return { messages: entries.slice(-limit).reverse().map(({ html: _html, text: _text, ...m }) => m) }
      },
    }),
    defineTool({
      name: 'logs',
      title: 'Dev server output',
      description: 'The newest lines the app server printed under `caldera dev` (requests, console output, errors).',
      input: z.object({ lines: z.number().int().min(1).max(2000).default(100), contains: z.string().optional().describe('Only lines containing this') }),
      annotations: read,
      handle: async ({ lines, contains }) => {
        const all = stripAnsi(readFileSync(devFile(root, 'dev.log'), 'utf8')).split('\n').filter((l) => l.trim())
        return { lines: (contains ? all.filter((l) => l.includes(contains)) : all).slice(-lines) }
      },
    }),
    defineTool({
      name: 'last_errors',
      title: 'Recent server errors',
      description: 'Unexpected errors (500s) the app hit under `caldera dev`, newest first, with method, path, message and a source-mapped stack (your .ts files and lines).',
      input: z.object({ limit: z.number().int().min(1).max(100).default(10) }),
      annotations: read,
      handle: async ({ limit }) => {
        const entries = readFileSync(devFile(root, 'dev-errors.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        return { errors: entries.slice(-limit).reverse() }
      },
    }),
    defineTool({
      name: 'db_query',
      title: 'Query the database (read-only)',
      description:
        'Runs one SQL statement against the app’s database and returns the rows. Read-only: it runs in a transaction that is always rolled back (Postgres: READ ONLY; SQLite: query_only), so writes are refused or undone.',
      input: z.object({ sql: z.string().min(1), limit: z.number().int().min(1).max(1000).default(100) }),
      annotations: read,
      handle: ({ sql: statement, limit }) => withProject(root, (project) => withApp(project, () => readOnlyQuery(project, statement, limit))),
    }),
    defineTool({
      name: 'route_call',
      title: 'Call a route',
      description: `Sends a request to the app in-process (no server needed) and returns status, headers and body. Add header "x-inertia: true" to get a page's props as JSON. ${
        allowWrites ? 'Any method.' : 'GET and HEAD only; other methods need `caldera mcp --allow-writes`.'
      }`,
      input: z.object({
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        path: z.string().startsWith('/'),
        headers: z.record(z.string(), z.string()).optional(),
        json: z.unknown().optional().describe('A JSON body (sets content-type)'),
      }),
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites, openWorldHint: false },
      handle: ({ method, path, headers, json }) => {
        if (!allowWrites && method !== 'GET' && method !== 'HEAD') throw new CalderaError('writes_disabled', `${method} can change data; restart the server with \`caldera mcp --allow-writes\` to allow it.`)
        return withProject(root, (project) => withApp(project, () => callRoute(project, { method, path, headers: headers ?? {}, json })))
      },
    }),
    defineTool({
      name: 'make',
      title: 'Generate a file',
      description: `Creates a file from Caldera's stubs (model, policy, page, job, mail, notification…) in its conventional place, then regenerates types. ${
        allowWrites ? 'Pass write: true to create the files; without it, returns what would be written.' : 'Returns what would be written (dry run); creating files needs `caldera mcp --allow-writes`.'
      }`,
      input: z.object({
        kind: z.enum(MAKE_KINDS),
        name: z.string().describe('e.g. BlogPost, or Posts/Index for a page'),
        event: z.string().optional().describe('For listeners: the event'),
        job: z.string().optional().describe('For schedules: the job'),
        table: z.boolean().optional().describe('For models: also create the table (default true)'),
        write: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: !allowWrites, destructiveHint: false, openWorldHint: false },
      handle: ({ kind, name, event, job, table, write }) =>
        withProject(root, (project) =>
          make(project, kind, name, { ...(event ? { event } : {}), ...(job ? { job } : {}), ...(table !== undefined ? { table } : {}), dryRun: !(allowWrites && write) }),
        ),
    }),
  ]
  if (allowWrites) {
    tools.push(
      defineTool({
        name: 'db_seed',
        title: 'Seed the database',
        description: 'Runs the seeders in src/db/seeders (in dependency order, one transaction). Refused in production.',
        input: z.object({ seed: z.number().int().optional().describe('Faker seed, for repeatable data'), only: z.array(z.string()).optional() }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        handle: ({ seed, only }) => withProject(root, (project) => seedProject(project, { ...(seed !== undefined ? { seed } : {}), ...(only ? { only } : {}) })),
      }),
    )
  }
  return tools
}

async function readOnlyQuery(project: Project, statement: string, limit: number) {
  const { defaultDatabase } = await project.importPackage<{ defaultDatabase(): QueryableDatabase }>('@caldera/db')
  // The project's own drizzle-orm, so the SQL object is one its driver recognises.
  const { sql } = await project.importPackage<{ sql: { raw(text: string): unknown } }>('drizzle-orm')
  let db: QueryableDatabase
  try {
    db = defaultDatabase()
  } catch {
    throw new CalderaError('no_database', 'The app has no database (no databaseProvider in src/app.ts).')
  }
  return runReadOnly(db, sql, statement, limit)
}

interface QueryableDatabase {
  driver: string
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>
}

/**
 * Runs one statement in a transaction that is always rolled back. Postgres refuses writes outright
 * (READ ONLY); SQLite too (query_only, reset before the rollback, since it's per connection).
 */
export async function runReadOnly(db: QueryableDatabase, sql: { raw(text: string): unknown }, statement: string, limit: number) {
  const ROLLBACK = new Error('rollback')
  let rows: unknown[] = []
  try {
    await db.transaction(async (tx) => {
      if (db.driver === 'postgres') {
        await tx.execute(sql.raw('set transaction read only'))
        const result = await tx.execute(sql.raw(statement))
        rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      } else if (db.driver === 'sqlite') {
        await tx.run(sql.raw('pragma query_only = on'))
        try {
          rows = (await tx.all(sql.raw(statement))) as unknown[]
        } finally {
          await tx.run(sql.raw('pragma query_only = off'))
        }
      } else {
        throw new CalderaError('db_query_unsupported', `db_query supports Postgres and async SQLite drivers, not "${db.driver}".`)
      }
      throw ROLLBACK
    })
  } catch (error) {
    if (error !== ROLLBACK) {
      if (error instanceof CalderaError) throw error
      // Drizzle wraps driver errors as "Failed query: …"; the driver's reason is what helps.
      const cause = (error as { cause?: { message?: string } }).cause?.message
      throw new CalderaError('query_failed', cause ? `${cause} (${statement})` : (error as Error).message)
    }
  }
  return { rows: rows.slice(0, limit), count: rows.length, truncated: rows.length > limit }
}

async function callRoute(project: Project, request: { method: string; path: string; headers: Record<string, string>; json: unknown }) {
  const module = await project.load('src/http.ts')
  const http = (module.http ?? module.default) as { request(input: string, init?: RequestInit, env?: unknown): Promise<Response> } | undefined
  if (!http || typeof http.request !== 'function') throw new CalderaError('http_missing', 'src/http.ts must export the Hono app as `http`.')
  const env = projectEnv(project)
  const base = new URL(typeof env.APP_URL === 'string' && env.APP_URL ? env.APP_URL : 'http://localhost:3000')
  const headers = new Headers(request.headers)
  if (request.json !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  // As the app's own pages would send it, so the origin check lets it through.
  if (request.method !== 'GET' && request.method !== 'HEAD' && !headers.has('origin')) headers.set('origin', base.origin)
  const started = Date.now()
  const send = () => http.request(new URL(request.path, base).toString(), { method: request.method, headers, ...(request.json !== undefined ? { body: JSON.stringify(request.json) } : {}) }, env)
  let response = await send()
  // An Inertia visit without the asset version gets 409 + the current version: send it and retry once.
  const version = response.headers.get('x-inertia-version')
  if (response.status === 409 && headers.get('x-inertia') === 'true' && !headers.has('x-inertia-version') && version) {
    headers.set('x-inertia-version', version)
    response = await send()
  }
  const type = response.headers.get('content-type') ?? ''
  const raw = new Uint8Array(await response.arrayBuffer())
  const text = /json|text|html|xml|javascript/.test(type) || !type ? new TextDecoder().decode(raw) : undefined
  let body: unknown = text === undefined ? `<${raw.length} bytes of ${type}>` : text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}… (${text.length} characters)` : text
  if (text !== undefined && type.includes('json') && text.length <= MAX_BODY) body = JSON.parse(text)
  return { status: response.status, ms: Date.now() - started, headers: Object.fromEntries(response.headers), body }
}

export const INSTRUCTIONS = `Caldera app tools. Read the app before changing it: \`describe\` (services, config, env keys), \`routes\`, \`db_schema\`, \`model\`, \`abilities\`. After edits, \`check\` (or \`generate\` when caldera dev isn't running). While debugging: \`last_errors\` (source-mapped stacks), \`logs\`, \`route_call\` to hit a route in-process, \`db_query\` for read-only SQL. \`make\` shows the conventional file for a new model/page/job/… (dry run unless writes are allowed). Conventions and commands are in AGENTS.md.`
