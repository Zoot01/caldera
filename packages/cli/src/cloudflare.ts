import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CalderaError } from '@caldera/core'
import { CONVENTIONS, type Project } from './project.js'

export const WRANGLER_FILE = 'wrangler.json'
export const WORKER_FILE = 'src/worker.ts'
/** Where `caldera d1:migrations` puts drizzle's migrations in the layout Wrangler applies. */
export const D1_MIGRATIONS_DIR = 'migrations'
/** The newest compatibility date the Wrangler Caldera suggests (4.151) runs locally. */
export const COMPATIBILITY_DATE = '2026-07-30'

const workerSource = (ext: string, ssr: boolean) => `import { setSsrRender, setViteManifest } from '@caldera/inertia'
import { handleQueueBatch, type MessageBatchLike } from '@caldera/queue'
import { handleScheduled } from '@caldera/schedule'
import { jobs } from '../.caldera/jobs.gen${ext}'
import { app } from './app${ext}'
import { http } from './http${ext}'
${ssr ? `// @ts-ignore: written by \`vite build --ssr\` (pnpm build), before wrangler bundles the Worker.
import render from '../build/ssr/ssr.js'

// Server-side rendering: the SSR build, bundled into the Worker.
setSsrRender(render)
` : ''}
interface Env {
  /** wrangler.json \`assets\`: public/, including the Vite build. */
  ASSETS: { fetch(input: Request | URL): Promise<Response> }
  [binding: string]: unknown
}
interface Context {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
  props: unknown
}

// Workers have no filesystem: the build manifest comes from the static assets, once per isolate.
let manifest: Promise<void> | undefined
const loadManifest = (env: Env, url: string) =>
  (manifest ??= env.ASSETS.fetch(new URL('/build/.vite/manifest.json', url)).then(async (response) => {
    if (response.ok) setViteManifest(await response.json())
  }))

/** The Worker: HTTP (src/http.ts), queued jobs (Cloudflare Queues) and schedules (Cron Triggers). */
export default {
  async fetch(request: Request, env: Env, ctx: Context) {
    await loadManifest(env, request.url)
    return http.fetch(request, env, ctx)
  },
  queue: (batch: MessageBatchLike, env: Env) => handleQueueBatch(app, batch, env, { jobs }),
  scheduled: (controller: { scheduledTime: number }, env: Env, ctx: Context) => ctx.waitUntil(handleScheduled(app, controller, env)),
}
`

function slug(project: Project): string {
  const manifest = existsSync(project.path('package.json')) ? (JSON.parse(readFileSync(project.path('package.json'), 'utf8')) as { name?: string }) : {}
  return (manifest.name ?? 'caldera-app').replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/g, '-')
}

/**
 * `caldera cloudflare:setup`: the files to run this app on Cloudflare Workers. The app picks the
 * Workers services from its bindings (D1 as DB, R2 as FILES, Queues as QUEUE, Email as EMAIL), so the
 * same code runs on Node. Writes wrangler.json, src/worker.ts and .dev.vars.example; never your code.
 */
export async function cloudflareSetup(project: Project, options: { force?: boolean } = {}) {
  const files = [WRANGLER_FILE, WORKER_FILE, '.dev.vars.example']
  const existing = files.filter((f) => existsSync(project.path(f)))
  if (existsSync(project.path('wrangler.toml')) || existsSync(project.path('wrangler.jsonc'))) existing.push(existsSync(project.path('wrangler.toml')) ? 'wrangler.toml' : 'wrangler.jsonc')
  if (existing.length && !options.force) throw new CalderaError('file_exists', `Refusing to overwrite ${existing.join(', ')}. Pass --force to replace.`, { files: existing })
  const name = slug(project)
  const schedules = existsSync(project.path(CONVENTIONS.schedulesDir)) && readdirSync(project.path(CONVENTIONS.schedulesDir)).some((f) => f.endsWith('.ts'))
  const config = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name,
    main: WORKER_FILE,
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    // public/ (with the Vite build in public/build) is served before the Worker runs.
    assets: { directory: 'public', binding: 'ASSETS' },
    d1_databases: [{ binding: 'DB', database_name: name, database_id: 'replace-with-wrangler-d1-create-id', migrations_dir: D1_MIGRATIONS_DIR }],
    r2_buckets: [{ binding: 'FILES', bucket_name: `${name}-files` }],
    // Caldera retries jobs itself (each job's tries and backoff), so the platform doesn't.
    queues: { producers: [{ binding: 'QUEUE', queue: `${name}-jobs` }], consumers: [{ queue: `${name}-jobs`, max_retries: 0 }] },
    send_email: [{ name: 'EMAIL' }],
    triggers: { crons: schedules ? ['* * * * *'] : [] },
    vars: { NODE_ENV: 'production', QUEUE_CONNECTION: 'cloudflare', MAIL_MAILER: 'cloudflare' },
  }
  writeFileSync(project.path(WRANGLER_FILE), `${JSON.stringify(config, null, 2)}\n`)
  mkdirSync(project.path('src'), { recursive: true })
  const ssr = existsSync(project.path('resources/ssr.tsx')) || existsSync(project.path('resources/ssr.ts'))
  writeFileSync(project.path(WORKER_FILE), workerSource(project.importExtension, ssr))
  writeFileSync(project.path('.dev.vars.example'), '# Local secrets for `wrangler dev` (copy to .dev.vars). In production: `wrangler secret put APP_KEY`.\nAPP_KEY=\n')
  return {
    schemaVersion: 1 as const,
    created: files,
    hints: [
      'Install Wrangler: `pnpm add -D wrangler@4.151.0` (or npm/yarn/bun).',
      'Local: copy .dev.vars.example to .dev.vars (set APP_KEY), `caldera d1:migrations`, `wrangler d1 migrations apply DB --local`, `pnpm build`, `wrangler dev`.',
      `Deploy: \`wrangler d1 create ${name}\` (put its id in wrangler.json), \`wrangler r2 bucket create ${name}-files\`, \`wrangler queues create ${name}-jobs\`, \`wrangler secret put APP_KEY\`, \`wrangler d1 migrations apply DB --remote\`, \`vite build\`, \`wrangler deploy\`.`,
      'Sending mail needs a domain onboarded to Cloudflare Email Service; until then, MAIL_MAILER=log.',
    ],
  }
}

/**
 * `caldera d1:migrations`: copies drizzle's migrations (drizzle/<timestamp>_<name>/migration.sql) to
 * migrations/<timestamp>_<name>.sql, the flat layout `wrangler d1 migrations apply` reads and tracks.
 */
export function d1Migrations(project: Project) {
  const source = project.path('drizzle')
  if (!existsSync(source)) throw new CalderaError('no_migrations', 'No drizzle/ folder: run `caldera db:generate` first.')
  const target = project.path(D1_MIGRATIONS_DIR)
  mkdirSync(target, { recursive: true })
  const copied: string[] = []
  const unchanged: string[] = []
  for (const entry of readdirSync(source, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = join(source, entry.name, 'migration.sql')
    if (!existsSync(sql)) continue
    const file = `${D1_MIGRATIONS_DIR}/${entry.name}.sql`
    if (existsSync(project.path(file)) && readFileSync(project.path(file), 'utf8') === readFileSync(sql, 'utf8')) {
      unchanged.push(file)
      continue
    }
    copyFileSync(sql, project.path(file))
    copied.push(file)
  }
  return { schemaVersion: 1 as const, copied, unchanged, hints: ['Apply: `wrangler d1 migrations apply DB --local` (or `--remote`).'] }
}

interface WranglerConfig {
  vars?: Record<string, unknown>
  d1_databases?: { binding: string }[]
  r2_buckets?: { binding: string }[]
  kv_namespaces?: { binding: string }[]
  queues?: { producers?: { binding: string }[] }
  send_email?: { name: string }[]
}

/** wrangler.json or wrangler.jsonc (comments stripped), or undefined. TOML isn't read. */
function readWrangler(project: Project): { file: string; config: WranglerConfig } | undefined {
  for (const file of ['wrangler.json', 'wrangler.jsonc']) {
    if (!existsSync(project.path(file))) continue
    const text = readFileSync(project.path(file), 'utf8').replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, string: string | undefined) => string ?? '')
    return { file, config: JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as WranglerConfig }
  }
  return undefined
}

export interface WorkersIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
  file?: string
  fix?: string
}

/**
 * What `caldera check` reports for an app with a Wrangler config: the app booted as Workers would
 * (wrangler.json's vars, its bindings present), then the defaults that can't work there.
 */
export async function workersIssues(project: Project, boot: (env: Record<string, unknown>) => Promise<{ config: Record<string, any>; shutdown(): Promise<void> }>): Promise<WorkersIssue[]> {
  const wrangler = readWrangler(project)
  if (!wrangler) return []
  const { config: w, file } = wrangler
  const bindings = [...(w.d1_databases ?? []), ...(w.r2_buckets ?? []), ...(w.kv_namespaces ?? []), ...(w.queues?.producers ?? [])].map((b) => b.binding).concat((w.send_email ?? []).map((b) => b.name))
  // A stand-in object per binding: config only checks they're there.
  const stub = () => new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) })
  const app = await boot({ ...(w.vars ?? {}), ...Object.fromEntries(bindings.map((name) => [name, stub()])) })
  const issues: WorkersIssue[] = []
  try {
    const c = app.config
    const pick = (section: { default?: string } & Record<string, any>, key: string) => section?.[key]?.[section.default ?? '']?.driver as string | undefined
    const mailer = pick(c.mail, 'mailers')
    if (mailer === 'smtp') {
      issues.push({ code: 'workers_smtp', severity: 'error', message: `On Workers the default mailer is "${c.mail.default}" (smtp), which needs TCP connections Workers don't allow. Use the cloudflare, resend, postmark or ses mailer.`, file: 'src/config/mail.ts' })
    }
    const queue = pick(c.queue, 'connections')
    if (queue === 'bullmq' || queue === 'database') {
      issues.push({ code: 'workers_queue', severity: 'error', message: `On Workers the default queue connection uses the ${queue} driver, which needs a long-running worker. Use cloudflare (Cloudflare Queues), qstash or deferred.`, file: 'src/config/queue.ts', fix: `set QUEUE_CONNECTION=cloudflare in ${file} vars` })
    }
    const disk = pick(c.storage, 'disks')
    if (disk === 'local') {
      issues.push({ code: 'workers_local_disk', severity: 'error', message: `On Workers the default disk "${c.storage.default}" is local; Workers have no lasting filesystem. Use r2 (an R2 binding) or s3.`, file: 'src/config/storage.ts' })
    }
    const store = pick(c.cache, 'stores')
    if (store === 'redis') {
      issues.push({ code: 'workers_redis', severity: 'error', message: 'On Workers the default cache store is redis (ioredis over TCP). Use the database store (D1) instead.', file: 'src/config/cache.ts' })
    }
  } finally {
    await app.shutdown()
  }
  const mailDir = project.path(CONVENTIONS.mailDir)
  for (const name of existsSync(mailDir) ? readdirSync(mailDir).filter((f) => f.endsWith('.tsx')) : []) {
    const source = readFileSync(join(mailDir, name), 'utf8')
    // React Email's own <Tailwind> compiles on every send; @caldera/mail/tailwind's is precompiled.
    if (/<Tailwind[\s>]/.test(source) && !source.includes('@caldera/mail/tailwind')) {
      issues.push({ code: 'workers_tailwind', severity: 'warning', message: `${CONVENTIONS.mailDir}/${name} uses React Email's <Tailwind>, which compiles Tailwind on every send: slow, and heavy for a Worker's CPU and size limits. Import Tailwind from '@caldera/mail/tailwind' instead (precompiled by caldera generate).`, file: `${CONVENTIONS.mailDir}/${name}`, fix: "import { Tailwind } from '@caldera/mail/tailwind'" })
    }
  }
  return issues
}
