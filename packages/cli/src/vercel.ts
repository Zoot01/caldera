import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { CalderaError } from '@caldera/core'
import type { WorkersIssue } from './cloudflare.js'
import { broadcastNowhere } from './broadcast.js'
import type { Project } from './project.js'

export const VERCEL_FILE = 'vercel.json'
export const VERCEL_FUNCTION = 'api/index.js'
/** Where `vercel pull --environment=production` writes the production env. */
export const VERCEL_PRODUCTION_ENV = '.vercel/.env.production.local'

export const VERCEL_BUNDLE = '.caldera/vercel/function.mjs'

const functionSource = `// The Vercel function: the app bundled by \`caldera vercel:build\` (vercel.json's buildCommand).
// Every request that isn't a file in public/ is rewritten here, keeping its URL.
export { default } from '../${VERCEL_BUNDLE}'
`

// Bundled into .caldera/vercel/function.mjs: the app's code compiled (TS, TSX, generated files);
// packages stay imports, so Vercel traces and ships them as usual.
const bundleEntry = (http: string, ssr: string | undefined) => `import { waitUntil } from '@vercel/functions'
import { http } from ${JSON.stringify(http)}
${ssr ? `import { setSsrRender } from '@caldera/inertia'\nimport render from ${JSON.stringify(ssr)}\n\n// Server-side rendering: the SSR build (vite build --ssr), bundled into the function.\nsetSsrRender(render)\n` : ''}
export default {
  fetch: (request) => http.fetch(request, undefined, { waitUntil, passThroughOnException() {}, props: {} }),
}
`

/**
 * `caldera vercel:setup`: deploy this app to Vercel (Node.js runtime, Fluid compute). Writes
 * vercel.json and api/index.ts; your code is unchanged. Static files and the Vite build are served
 * from public/ by Vercel's CDN; everything else reaches the app.
 */
export function vercelSetup(project: Project, options: { force?: boolean } = {}) {
  const files = [VERCEL_FILE, VERCEL_FUNCTION]
  const existing = files.filter((f) => existsSync(project.path(f)))
  if (existing.length && !options.force) throw new CalderaError('file_exists', `Refusing to overwrite ${existing.join(', ')}. Pass --force to replace.`, { files: existing })
  const inertia = existsSync(project.path('vite.config.ts')) || existsSync(project.path('vite.config.js'))
  const ssr = existsSync(project.path('resources/ssr.tsx')) || existsSync(project.path('resources/ssr.ts'))
  const config = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    // Not a framework preset: the build is ours, and api/index.ts is the app.
    framework: null,
    // Generates .caldera/ (not committed) and bundles the app for api/index.js.
    // With SSR, the SSR build comes first: vercel:build bundles it into the function.
    buildCommand: ssr ? 'caldera generate && vite build && vite build --ssr && caldera vercel:build' : inertia ? 'caldera vercel:build && vite build' : 'caldera vercel:build',
    outputDirectory: 'public',
    // Functions can't read the static output, so the Vite manifest ships with the function.
    ...(inertia ? { functions: { [VERCEL_FUNCTION]: { includeFiles: 'public/build/.vite/manifest.json' } } } : {}),
    // After files in public/: everything goes to the app, with its URL unchanged.
    rewrites: [{ source: '/(.*)', destination: '/api' }],
  }
  writeFileSync(project.path(VERCEL_FILE), `${JSON.stringify(config, null, 2)}\n`)
  mkdirSync(project.path('api'), { recursive: true })
  writeFileSync(project.path(VERCEL_FUNCTION), functionSource)
  return {
    schemaVersion: 1 as const,
    created: files,
    hints: [
      'Install the runtime helper: `pnpm add @vercel/functions` (or npm/yarn/bun).',
      'Production env (Vercel project settings): APP_KEY; DATABASE_URL to a hosted database (Turso `libsql://…?authToken=…`, or Postgres); QUEUE_CONNECTION=deferred (or redis/QStash); S3_* for files; a mailer (RESEND_API_KEY, POSTMARK_SERVER_TOKEN…); CRON_SECRET if you have schedules.',
      'Schedules: `caldera schedule:sync --target vercel` adds them to vercel.json as Vercel Cron Jobs.',
      'Realtime: functions can’t hold WebSockets, so broadcasts are only logged until you pick a server: BROADCAST_CONNECTION=pusher (hosted Pusher: PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER), or server with BROADCAST_HOST pointing at one elsewhere.',
      'Check it: `vercel pull --environment=production`, then `caldera check` (it reads that env). Build locally: `vercel build`.',
    ],
  }
}

/**
 * What `caldera check` reports for an app with a vercel.json, booted with the production env from
 * `vercel pull` (`.vercel/.env.production.local`): the defaults that can't work on serverless
 * functions. Without a pulled env, one warning says how to get it.
 */
export async function vercelIssues(
  project: Project,
  boot: (env: Record<string, unknown>, options?: { local?: boolean }) => Promise<{ config: Record<string, any>; shutdown(): Promise<void> }>,
): Promise<WorkersIssue[]> {
  if (!existsSync(project.path(VERCEL_FILE))) return []
  if (!existsSync(project.path(VERCEL_PRODUCTION_ENV))) {
    return [{ code: 'vercel_env_unknown', severity: 'warning', message: `${VERCEL_FILE} is here, but not the production env, so Vercel-specific problems can't be checked.`, fix: 'vercel pull --environment=production' }]
  }
  const pulled = parseEnv(readFileSync(project.path(VERCEL_PRODUCTION_ENV), 'utf8')) as Record<string, string>
  // Vercel hides sensitive values (now the default for production) from `vercel pull`.
  const hidden = Object.keys(pulled).filter((key) => pulled[key] === '[SENSITIVE]')
  const known = Object.fromEntries(Object.entries(pulled).filter(([key]) => !hidden.includes(key)))
  // With every value known, only the production env; otherwise local values stand in for the hidden
  // ones (so the app boots), and a check whose deciding variable is hidden is skipped, not guessed.
  const app = await boot({ ...known, VERCEL: '1' }, { local: hidden.length > 0 })
  const decidedBy = (...keys: string[]) => !keys.some((key) => hidden.includes(key))
  const skipped: string[] = []
  const issues: WorkersIssue[] = []
  try {
    const c = app.config
    const pick = (section: { default?: string } & Record<string, any>, key: string) => section?.[key]?.[section.default ?? '']?.driver as string | undefined
    const url = String(c.database?.url ?? '')
    if (!decidedBy('DATABASE_URL')) skipped.push('database')
    else if (/^(file:|:memory:)/.test(url) || url === '') {
      issues.push({ code: 'vercel_local_database', severity: 'error', message: `On Vercel DATABASE_URL is "${url || '(unset)'}": a function's disk doesn't last between requests. Use a hosted database (Turso libsql://…, or Postgres).`, file: 'src/config/database.ts' })
    }
    const queue = pick(c.queue, 'connections')
    if (!decidedBy('QUEUE_CONNECTION')) skipped.push('queue')
    else if (queue === 'database' || queue === 'bullmq') {
      issues.push({ code: 'vercel_queue', severity: 'error', message: `On Vercel the default queue connection uses the ${queue} driver, which needs a long-running worker (\`caldera queue:work\`) that Vercel doesn't run. Use deferred (after the response), or QStash; or run the worker elsewhere.`, file: 'src/config/queue.ts', fix: 'set QUEUE_CONNECTION=deferred in the Vercel project' })
    }
    if (!decidedBy('S3_BUCKET')) skipped.push('storage')
    else if (pick(c.storage, 'disks') === 'local') {
      issues.push({ code: 'vercel_local_disk', severity: 'error', message: `On Vercel the default disk "${c.storage.default}" is local; functions have a read-only filesystem. Use s3 (Amazon S3, Cloudflare R2, Tigris…).`, file: 'src/config/storage.ts' })
    }
    const broadcast = c.broadcast?.connections?.[c.broadcast?.default ?? ''] as { driver?: string; host?: string } | undefined
    if (!decidedBy('BROADCAST_CONNECTION', 'BROADCAST_HOST')) skipped.push('broadcast')
    else if (broadcast?.driver === 'pusher' && broadcast.host && /^(127\.|localhost$|0\.0\.0\.0$|::1$)/.test(broadcast.host)) {
      issues.push({ code: 'vercel_broadcast_local', severity: 'error', message: `On Vercel the default broadcast connection "${c.broadcast.default}" publishes to ${broadcast.host}. Functions can't hold WebSockets, so the realtime server runs elsewhere: hosted Pusher, or a pusher-protocol server (caldera broadcast:serve, Soketi, Reverb, a Cloudflare BroadcastHub) at BROADCAST_HOST.`, file: 'src/config/broadcast.ts' })
    }
    else issues.push(...(await broadcastNowhere(project, c.broadcast, 'Vercel')))
    if (!decidedBy('REDIS_URL')) skipped.push('cache')
    else if (pick(c.cache, 'stores') === 'memory') {
      issues.push({ code: 'vercel_memory_cache', severity: 'warning', message: 'On Vercel the default cache store is memory: each function instance has its own, so rate limits and locks aren’t shared. Use the database store, or Redis.', file: 'src/config/cache.ts' })
    }
  } finally {
    await app.shutdown()
  }
  if (hidden.length) {
    issues.push({
      code: 'vercel_env_hidden',
      severity: 'warning',
      message: `Vercel doesn't reveal sensitive production values to \`vercel pull\` (${hidden.join(', ')}), so ${skipped.length ? `the ${skipped.join(', ')} checks were skipped` : 'checks used the readable values'}. Mark plain settings (QUEUE_CONNECTION, MAIL_MAILER…) as not sensitive to check them.`,
    })
  }
  return issues
}

/**
 * `caldera vercel:build` (vercel.json's buildCommand): `caldera generate`, then the app's own code
 * bundled to .caldera/vercel/function.mjs. Vercel's Node builder compiles `.ts` imports but not
 * `.tsx` ones (mail templates, React components), so the app is compiled here; packages stay
 * imports, so Vercel traces and ships node_modules (native ones included) as it always does.
 */
export async function vercelBuild(project: Project, generateFirst: () => Promise<unknown>) {
  await generateFirst()
  const { build } = await import('esbuild')
  const http = project.path('src/http.ts')
  if (!existsSync(http)) throw new CalderaError('missing_file', 'vercel:build bundles src/http.ts (the app\'s Hono app), which is missing.', { file: 'src/http.ts' })
  const ssr = existsSync(project.path('build/ssr/ssr.js')) ? project.path('build/ssr/ssr.js') : undefined
  const result = await build({
    stdin: { contents: bundleEntry(http, ssr), resolveDir: project.root, loader: 'js', sourcefile: 'vercel-function.js' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    jsx: 'automatic',
    // libSQL's Node client loads a native package by a computed name, which Vercel's tracer can't
    // follow, so the function would fail to load. On Vercel the database is remote anyway (functions
    // have no lasting disk): the web client (libsql://, https://, wss://) has no native code.
    alias: { 'drizzle-orm/libsql': 'drizzle-orm/libsql/web' },
    // Inline: Vercel's tracer ships imported files, not .map files, and stacks should name src/ lines.
    sourcemap: 'inline',
    outfile: project.path(VERCEL_BUNDLE),
    logLevel: 'silent',
    metafile: true,
  })
  const inputs = Object.keys(result.metafile.inputs).filter((file) => !file.includes('node_modules'))
  return { schemaVersion: 1 as const, bundle: VERCEL_BUNDLE, modules: inputs.length, ssr: Boolean(ssr), warnings: result.warnings.map((w) => w.text) }
}
