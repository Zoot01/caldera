import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'
/** `inertia`: React pages over Inertia, served by the app (Vite). `next`: a Next.js app with Caldera behind /api. */
export type Frontend = 'inertia' | 'next'
export const FRONTENDS = ['inertia', 'next'] as const

export interface CreateOptions {
  /** Where to create the app. Must not exist, or be empty. */
  directory: string
  packageManager?: PackageManager
  /** Default `inertia`. */
  frontend?: Frontend
  install?: boolean
  git?: boolean
  /** Development only: point @caldera/* dependencies at a local checkout's packages/ folder. */
  link?: string
  /** Defaults to the real process environment; injectable for tests. */
  env?: NodeJS.ProcessEnv
}

export interface Step {
  name: 'files' | 'install' | 'generate' | 'database' | 'git'
  status: 'done' | 'skipped' | 'failed'
  /** What to run yourself when the step was skipped or failed. */
  command?: string
}

export interface CreateResult {
  schemaVersion: 1
  directory: string
  name: string
  packageManager: PackageManager
  frontend: Frontend
  steps: Step[]
  /** Commands to finish setup, in order. Empty when everything succeeded. */
  next: string[]
  log: string
}

export class CreateError extends Error {
  constructor(
    readonly code: 'dir_not_empty' | 'invalid_name' | 'template_missing',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

const TEMPLATE = new URL('../template/', import.meta.url)
const TEMPLATE_NEXT = new URL('../template-next/', import.meta.url)
const CALDERA_PACKAGES = ['core', 'db', 'http', 'cli', 'auth', 'inertia', 'cache', 'queue', 'events', 'schedule', 'storage', 'mail', 'notifications', 'broadcast', 'i18n', 'next', 'testing']

/**
 * Creates a Caldera app. Only writing the files can fail; every later step (install, codegen,
 * database, git) is best-effort: it's logged to .create.log, retried once, and on failure the
 * exact command to finish it is returned in `next`.
 */
export function createProject(options: CreateOptions): CreateResult {
  const env = options.env ?? process.env
  const directory = resolve(options.directory)
  const name = packageName(basename(directory))

  // Validate before any side effect: nothing is ever deleted or merged into.
  const suggestion = unavailable(directory)
  if (suggestion) {
    throw new CreateError('dir_not_empty', `${directory} already exists and isn't empty. Try \`${suggestion}\` instead.`, { directory, suggestion })
  }
  if (!existsSync(TEMPLATE)) throw new CreateError('template_missing', 'The bundled template is missing; reinstall create-caldera.')

  const pm = options.packageManager ?? detectPackageManager(env)
  const run = pm === 'npm' ? 'npm run' : pm
  const log = join(directory, '.create.log')

  // 1. Files: the only step allowed to fail the run.
  mkdirSync(directory, { recursive: true })
  cpSync(TEMPLATE, directory, { recursive: true })
  renameSync(join(directory, '_gitignore'), join(directory, '.gitignore'))
  const frontend = options.frontend ?? 'inertia'
  if (frontend === 'next') applyNext(directory)
  for (const file of listFiles(directory)) {
    const text = readFileSync(file, 'utf8')
    if (text.includes('{{')) writeFileSync(file, text.replaceAll('{{ name }}', name).replaceAll('{{ run }}', run))
  }
  writeFileSync(
    join(directory, '.env'),
    readFileSync(join(directory, '.env.example'), 'utf8')
      .replace('APP_KEY=', `APP_KEY=${randomBytes(32).toString('base64url')}`)
      .replace('BROADCAST_SECRET=', `BROADCAST_SECRET=${randomBytes(24).toString('base64url')}`),
  )
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
  const version = packageManagerVersion(pm, env)
  if (version) manifest.packageManager = `${pm}@${version}` // never a bare name: corepack rejects it
  const overrides = options.link ? linkLocalPackages(manifest, resolve(options.link), directory, pm) : []
  if (options.link) appendFileSync(join(directory, '.gitignore'), '.caldera-local\n')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  if (pm === 'pnpm') {
    // pnpm 11 fails installs whose dependencies' build scripts aren't approved. esbuild (used by
    // tsx and vitest) has one; approve it up front so a fresh install can't fail on it.
    // msgpackr-extract (from bullmq) only compiles when no prebuilt binary exists, so it's declined.
    // workerd (Cloudflare's runtime, with Wrangler after `caldera cloudflare:setup`) is approved.
    const workspace = ['allowBuilds:', '  esbuild: true', '  msgpackr-extract: false', '  workerd: true', ...(overrides.length ? ['overrides:', ...overrides] : [])]
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), `${workspace.join('\n')}\n`)
  }
  writeFileSync(log, `create-caldera ${new Date().toISOString()}\n`)

  const steps: Step[] = [{ name: 'files', status: 'done' }]
  const attempt = (stepName: Step['name'], enabled: boolean, command: string[]) => {
    const display = command.join(' ')
    if (!enabled) return void steps.push({ name: stepName, status: 'skipped', command: display })
    for (let tries = 1; tries <= 2; tries++) {
      appendFileSync(log, `\n$ ${display}  (attempt ${tries})\n`)
      const result = spawnSync(command[0]!, command.slice(1), { cwd: directory, env, encoding: 'utf8', shell: process.platform === 'win32' })
      appendFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}\nexit ${result.status}\n`)
      if (result.status === 0) return void steps.push({ name: stepName, status: 'done' })
    }
    steps.push({ name: stepName, status: 'failed', command: display })
  }

  const install = options.install ?? true
  attempt('install', install, [pm, 'install'])
  const installed = steps.at(-1)!.status === 'done'
  attempt('generate', installed, [pm, ...(pm === 'npm' ? ['exec', '--'] : pm === 'pnpm' ? ['exec'] : []), 'caldera', 'generate'])
  // Migrations first, as in production: the initial one is generated and applied (and committed with
  // the app); tests build their database from the same migrations.
  const exec = [pm, ...(pm === 'npm' ? ['exec', '--'] : pm === 'pnpm' ? ['exec'] : [])]
  const migrate = [...exec, 'caldera', 'db:migrate']
  attempt('database', installed, [...exec, 'caldera', 'db:generate', '--', '--name', 'init'])
  if (steps.at(-1)!.status === 'done') {
    steps.pop()
    attempt('database', true, migrate)
  } else {
    // Not generated, so not applied either: finishing takes both.
    const step = steps.at(-1)!
    step.command = `${step.command} && ${migrate.join(' ')}`
  }
  const git = (options.git ?? true) && commandExists('git', env)
  if (git) {
    attempt('git', true, ['git', 'init', '-q'])
    if (steps.at(-1)!.status === 'done') {
      steps.pop()
      attempt('git', true, ['git', 'add', '-A'])
      if (steps.at(-1)!.status === 'done') {
        steps.pop()
        attempt('git', true, ['git', 'commit', '-q', '-m', 'Initial commit from create-caldera'])
      }
    }
  } else {
    steps.push({ name: 'git', status: 'skipped', command: 'git init && git add -A && git commit -m "Initial commit"' })
  }

  const relative = options.directory
  const next = [
    `cd ${relative}`,
    ...steps.filter((s) => s.status !== 'done' && s.command && s.name !== 'git').map((s) => s.command!),
    `${run} dev`,
  ]
  return { schemaVersion: 1, directory, name, packageManager: pm, frontend, steps, next, log }
}

/** `--pm`, then the package manager that ran us, then what's installed, then npm. */
export function detectPackageManager(env: NodeJS.ProcessEnv): PackageManager {
  const agent = env.npm_config_user_agent ?? ''
  for (const pm of ['pnpm', 'yarn', 'bun', 'npm'] as const) if (agent.startsWith(`${pm}/`)) return pm
  for (const pm of ['pnpm', 'bun', 'yarn'] as const) if (commandExists(pm, env)) return pm
  return 'npm'
}

/** The exact version, only when the package manager told us itself (its user agent). */
export function packageManagerVersion(pm: PackageManager, env: NodeJS.ProcessEnv): string | undefined {
  const match = (env.npm_config_user_agent ?? '').match(new RegExp(`^${pm}/(\\d+\\.\\d+\\.\\d+)`))
  return match?.[1]
}

/**
 * Development: install @caldera/* from a local checkout the way users get them from npm. Each
 * package is packed into a tarball (workspace:* ranges become versions, devDependencies drop out)
 * and installed from it, so peers such as drizzle-orm resolve to the app's single copy. A plain
 * `link:` would make each package use the checkout's own node_modules: two drizzle-orm copies,
 * whose types don't match.
 */
function linkLocalPackages(manifest: Record<string, any>, checkout: string, directory: string, pm: PackageManager): string[] {
  const dest = join(directory, '.caldera-local')
  mkdirSync(dest, { recursive: true })
  const tarballs: Record<string, string> = {}
  for (const short of CALDERA_PACKAGES) {
    const source = join(checkout, 'packages', short)
    const packed = spawnSync('pnpm', ['pack', '--pack-destination', dest], { cwd: source, encoding: 'utf8', shell: process.platform === 'win32' })
    const file = readdirSync(dest).find((f) => f.startsWith(`caldera-${short}-`) && f.endsWith('.tgz'))
    if (packed.status !== 0 || !file) throw new Error(`Couldn't pack @caldera/${short}: ${packed.stderr || packed.stdout}`)
    tarballs[`@caldera/${short}`] = `file:./.caldera-local/${file}`
  }
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const dep of Object.keys(manifest[field] ?? {})) if (tarballs[dep]) manifest[field][dep] = tarballs[dep]
  }
  // Caldera packages depend on each other by version; point those at the tarballs too.
  if (pm === 'npm') manifest.overrides = { ...manifest.overrides, ...tarballs }
  else if (pm === 'yarn') manifest.resolutions = { ...manifest.resolutions, ...tarballs }
  else if (pm === 'bun') manifest.overrides = { ...manifest.overrides, ...tarballs }
  return Object.entries(tarballs).map(([name, spec]) => `  '${name}': '${spec}'`)
}

function packageName(folder: string): string {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9-~._]+/g, '-')
    .replace(/^[-._]+|-+$/g, '')
  if (!name) throw new CreateError('invalid_name', `Can't derive a package name from "${folder}".`)
  return name
}

/** A free sibling name when `directory` exists and isn't empty, otherwise undefined. */
export function unavailable(directory: string): string | undefined {
  const target = resolve(directory)
  if (!existsSync(target) || (statSync(target).isDirectory() && readdirSync(target).length === 0)) return undefined
  return basename(freeName(target))
}

function freeName(directory: string): string {
  for (let i = 2; ; i++) if (!existsSync(`${directory}-${i}`)) return `${directory}-${i}`
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  return (env.PATH ?? '').split(delimiter).some((dir) => dir && extensions.some((ext) => existsSync(join(dir, command + ext))))
}

/** What the Next.js variant drops from the shared template: Inertia pages, Vite, the Node server entry. */
const NEXT_REMOVES = ['resources', 'vite.config.ts', 'src/inertia.ts', 'src/server.ts', 'src/uploads.ts', 'public/build']

/**
 * Turns the shared template into the Next.js variant: Next renders pages from app/, and the Caldera
 * app (models, jobs, mail, i18n…) serves /api and is used directly from Server Components and actions.
 */
function applyNext(directory: string) {
  for (const path of NEXT_REMOVES) rmSync(join(directory, path), { recursive: true, force: true })
  cpSync(TEMPLATE_NEXT, directory, { recursive: true, force: true })
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> }
  for (const name of ['@caldera/inertia', '@inertiajs/core', '@inertiajs/react', '@hono/node-server']) delete manifest.dependencies[name]
  for (const name of ['@inertiajs/vite', '@vitejs/plugin-react', 'vite']) delete manifest.devDependencies[name]
  manifest.dependencies['@caldera/next'] = '^0.0.0'
  manifest.dependencies.next = '^16.4.2'
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)))
  Object.assign(manifest.scripts, { build: 'next build', start: 'next start' })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  appendFileSync(join(directory, '.gitignore'), '.next\nnext-env.d.ts\n')
  // Next resolves like a bundler: relative imports have no extension (the Inertia template, run by
  // Node, imports `./app.js`). `caldera generate` and `make` follow the tsconfig.
  for (const file of listFiles(directory)) {
    if (!/\.tsx?$/.test(file) || file.includes(`${join(directory, 'node_modules')}`)) continue
    const text = readFileSync(file, 'utf8')
    const stripped = text.replace(/((?:from|import)\s*\(?\s*'\.{1,2}\/[^']+)\.js'/g, "$1'")
    if (stripped !== text) writeFileSync(file, stripped)
  }
  const agentsPath = join(directory, 'AGENTS.md')
  let agents = readFileSync(agentsPath, 'utf8')
  agents = agents
    .replace(/^A \[Caldera\].*$/m, 'A [Caldera](https://caldera.dev) app with a Next.js frontend: TypeScript, Hono, Drizzle, Zod. Next renders the pages (`app/`); the Caldera app serves `/api` and does the backend work.')
    .replace(
      /^Pages get their data.*$/m,
      "Server Components and server actions use Caldera directly: `await services(app)` (db, mail, queue, cache, storage…) and `await requestContext(app)` (this request's `i18n`; add `authenticate({ required: false })` from `@caldera/auth` for `user`), both from `@caldera/next`. Models work as anywhere else. Client components call the API with the typed client: `createClient<AppType>()` from `@caldera/next/client`, with `AppType` from `src/http.ts`. `/api/*` is the Caldera app (`app/api/[[...route]]/route.ts`), with your routes from `src/routes`; `/_caldera/*` (signed file links, mail previews) is rewritten there by `next.config.ts`.",
    )
    .split('\n')
    .filter((line) => !/resources\/pages|src\/inertia\.ts|resources\/app\.tsx|src\/uploads\.ts|x-inertia|rootView/.test(line))
    .join('\n')
    .replace('| Providers |', '| Pages, layouts, server actions (Next.js) | `app/**` | |\n| Providers |')
    .replace(/A page lists what it needs with `export const messages[^.]*\.[^.]*\./, 'In Server Components and actions, translate with `requestContext(app)`’s `i18n`.')
  writeFileSync(agentsPath, agents)
}
