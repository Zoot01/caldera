import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'
/** `inertia`: React pages over Inertia, served by the app (Vite). `next`: a Next.js app with Caldera behind /api. */
export type Frontend = 'inertia' | 'next'
export const FRONTENDS = ['inertia', 'next'] as const
/** `starter`: auth, settings and a dashboard. `blank`: the UI setup and one page (Inertia), or the Next.js demo page. */
export type Kit = 'starter' | 'blank'
export const KITS = ['starter', 'blank'] as const
export type Database = 'sqlite' | 'postgres'
export const DATABASES = ['sqlite', 'postgres'] as const
/** Where it will run: `node` needs nothing extra; the others run `caldera <target>:setup`. */
export type Target = 'node' | 'vercel' | 'cloudflare'
export const TARGETS = ['node', 'vercel', 'cloudflare'] as const

export interface CreateOptions {
  /** Where to create the app. Must not exist, or be empty. */
  directory: string
  packageManager?: PackageManager
  /** Default `inertia`. */
  frontend?: Frontend
  /** Default `starter`. */
  kit?: Kit
  /** Teams (Better Auth organizations): the starter kit only. Default false. */
  teams?: boolean
  /** Default `sqlite` (libSQL: a local file, or Turso). */
  database?: Database
  /** Default `node`. */
  target?: Target
  install?: boolean
  git?: boolean
  /** Development only: point @caldera/* dependencies at a local checkout's packages/ folder. */
  link?: string
  /** Defaults to the real process environment; injectable for tests. */
  env?: NodeJS.ProcessEnv
  /** Progress, for a terminal: each step as it starts (`running`) and ends. Skipped steps aren't reported. */
  onStep?: (step: { name: Step['name']; status: 'running' | Exclude<Step['status'], 'skipped'> }) => void
}

export interface Step {
  name: 'files' | 'install' | 'generate' | 'database' | 'target' | 'git'
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
  kit: Kit
  teams: boolean
  database: Database
  target: Target
  steps: Step[]
  /** Commands to finish setup, in order. Empty when everything succeeded. */
  next: string[]
  log: string
}

export class CreateError extends Error {
  constructor(
    readonly code: 'dir_not_empty' | 'invalid_name' | 'template_missing' | 'unsupported',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

// The app is copied in layers, each over the last: the shared base, then the frontend (a kit, or
// the Next.js variant), then the database's files.
const TEMPLATE = new URL('../template/', import.meta.url)
const TEMPLATE_NEXT = new URL('../template-next/', import.meta.url)
const KIT_LAYERS: Record<Kit, URL[]> = {
  blank: [new URL('../kits/blank/', import.meta.url)],
  starter: [new URL('../kits/blank/', import.meta.url), new URL('../kits/starter/', import.meta.url)],
}
const POSTGRES = new URL('../databases/postgres/', import.meta.url)
// The Next.js starter: its own pages, layouts and routes; the rest comes from the Inertia kits (KITS).
const NEXT_STARTER = new URL('../kits/next-starter/', import.meta.url)
const KITS_DIR = new URL('../kits/', import.meta.url)
const NEXT_STARTER_TEAMS = new URL('../kits/next-starter-teams/', import.meta.url)
// The starter's auth tables for Postgres (its own files are SQLite's).
const STARTER_POSTGRES = new URL('../kits/starter-postgres/', import.meta.url)
// Teams, over the starter; and its auth tables for Postgres.
const STARTER_TEAMS = new URL('../kits/starter-teams/', import.meta.url)
const STARTER_TEAMS_POSTGRES = new URL('../kits/starter-teams-postgres/', import.meta.url)
// Added for the target, so the first install has them (the setup commands only write files).
const TARGET_DEPENDENCIES: Record<Target, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> = {
  node: {},
  vercel: { dependencies: { '@vercel/functions': '^3.4.0' } },
  cloudflare: { devDependencies: { wrangler: '4.151.0' } },
}
const CALDERA_PACKAGES = ['core', 'db', 'http', 'cli', 'auth', 'inertia', 'cache', 'queue', 'events', 'schedule', 'storage', 'mail', 'notifications', 'broadcast', 'i18n', 'next', 'testing']

/** The targets that work with this frontend and database, in prompt order. */
export function targetsFor(frontend: Frontend, database: Database): Target[] {
  return TARGETS.filter((target) => !unsupported(frontend, database, target))
}

/** Why a combination can't be created, or undefined when it can. */
export function unsupported(frontend: Frontend, database: Database, target: Target): string | undefined {
  if (target !== 'cloudflare') return undefined
  if (frontend === 'next') return 'The Next.js variant doesn’t run on Cloudflare Workers yet; use --target node or vercel.'
  if (database === 'postgres') return 'Cloudflare Workers apps use D1 (SQLite); use --database sqlite, or --target node or vercel for Postgres.'
  return undefined
}

/**
 * Creates a Caldera app. Only writing the files can fail; every later step (install, codegen,
 * database, git) is best-effort: it's logged to .create.log, retried once, and on failure the
 * exact command to finish it is returned in `next`.
 */
export async function createProject(options: CreateOptions): Promise<CreateResult> {
  const env = options.env ?? process.env
  const directory = resolve(options.directory)
  const name = packageName(basename(directory))

  // Validate before any side effect: nothing is ever deleted or merged into.
  const suggestion = unavailable(directory)
  if (suggestion) {
    throw new CreateError('dir_not_empty', `${directory} already exists and isn't empty. Try \`${suggestion}\` instead.`, { directory, suggestion })
  }
  if (!existsSync(TEMPLATE)) throw new CreateError('template_missing', 'The bundled template is missing; reinstall create-caldera.')
  const frontend = options.frontend ?? 'inertia'
  const kit = options.kit ?? 'starter'
  const database = options.database ?? 'sqlite'
  const target = options.target ?? 'node'
  const teams = options.teams ?? false
  if (teams && kit !== 'starter') throw new CreateError('unsupported', 'Teams come with the starter kit: leave out --blank, or --teams.', { kit, frontend })
  const problem = unsupported(frontend, database, target)
  if (problem) throw new CreateError('unsupported', problem, { frontend, database, target })

  const pm = options.packageManager ?? detectPackageManager(env)
  // `bun test` is Bun's own test runner, not the script.
  const run = pm === 'npm' || pm === 'bun' ? `${pm} run` : pm
  const log = join(directory, '.create.log')

  // 1. Files: the only step allowed to fail the run.
  mkdirSync(directory, { recursive: true })
  cpSync(TEMPLATE, directory, { recursive: true })
  renameSync(join(directory, '_gitignore'), join(directory, '.gitignore'))
  // The database's files first, so a kit can replace them (the starter's users table has auth columns).
  if (database === 'postgres') cpSync(POSTGRES, directory, { recursive: true, force: true })
  // Browser tests (Playwright) come with every kit but the Next.js demo page.
  const browserTests = frontend === 'inertia' || kit === 'starter'
  if (browserTests) {
    edit(directory, 'AGENTS.md', [
      [/^Tests \(`pnpm test`, Vitest\).*$/m, `$&\n\n${BROWSER_AGENTS}`],
      ['- `pnpm typecheck`, `pnpm test`', '- `pnpm typecheck`, `pnpm test`, `pnpm test:browser`'],
    ])
    edit(directory, 'README.md', [['{{ run }} test       # run the tests\n', '{{ run }} test       # run the tests\n{{ run }} test:browser  # browser tests (Playwright; once: npx playwright install chromium)\n']])
  }
  if (frontend === 'inertia') {
    for (const layer of KIT_LAYERS[kit]) if (existsSync(layer)) copyLayer(layer, directory)
    if (kit === 'starter') applyStarter(directory, database)
    if (teams) applyTeams(directory, database)
  } else {
    applyNext(directory)
    if (kit === 'starter') applyNextStarter(directory, database)
    if (teams) applyNextTeams(directory, database)
  }
  if (database === 'postgres') applyPostgres(directory, name)
  // Both variants resolve like a bundler (Vite, Next, tsx): relative imports have no extension,
  // which is also what `caldera generate` and `make` write.
  extensionlessImports(directory)
  for (const file of listFiles(directory)) {
    const text = readFileSync(file, 'utf8')
    if (text.includes('{{')) writeFileSync(file, text.replaceAll('{{ name }}', name).replaceAll('{{ run }}', run))
  }
  writeFileSync(
    join(directory, '.env'),
    readFileSync(join(directory, '.env.example'), 'utf8')
      .replace('APP_KEY=', `APP_KEY=${randomBytes(32).toString('base64url')}`),
  )
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const added = TARGET_DEPENDENCIES[target][field]
    if (added) manifest[field] = sorted({ ...manifest[field], ...added })
  }
  if (target === 'cloudflare') appendFileSync(join(directory, '.gitignore'), '.dev.vars\n.wrangler\n')
  const version = packageManagerVersion(pm, env)
  if (browserTests) {
    // Browser tests (Playwright) and CI that runs them.
    appendFileSync(join(directory, '.gitignore'), 'test-results/\nplaywright-report/\nblob-report/\n')
    mkdirSync(join(directory, '.github/workflows'), { recursive: true })
    writeFileSync(join(directory, '.github/workflows/ci.yml'), ciWorkflow(pm, run, database, name, version))
  }
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
  options.onStep?.({ name: 'files', status: 'done' })
  // Async, so a terminal can show progress (a spinner) while installing.
  const attempt = async (stepName: Step['name'], enabled: boolean, command: string[]) => {
    const display = command.join(' ')
    if (!enabled) return void steps.push({ name: stepName, status: 'skipped', command: display })
    options.onStep?.({ name: stepName, status: 'running' })
    for (let tries = 1; tries <= 2; tries++) {
      appendFileSync(log, `\n$ ${display}  (attempt ${tries})\n`)
      const result = await runCommand(command, directory, env)
      appendFileSync(log, `${result.output}\nexit ${result.status}\n`)
      if (result.status === 0) return void steps.push({ name: stepName, status: 'done' })
    }
    steps.push({ name: stepName, status: 'failed', command: display })
  }
  const report = () => {
    const step = steps.at(-1)!
    if (step.status !== 'skipped') options.onStep?.({ name: step.name, status: step.status })
  }

  const install = options.install ?? true
  await attempt('install', install, [pm, 'install'])
  report()
  const installed = steps.at(-1)!.status === 'done'
  await attempt('generate', installed, [pm, ...(pm === 'npm' ? ['exec', '--'] : pm === 'pnpm' ? ['exec'] : []), 'caldera', 'generate'])
  report()
  // Migrations first, as in production: the initial one is generated and applied (and committed with
  // the app); tests build their database from the same migrations.
  const exec = [pm, ...(pm === 'npm' ? ['exec', '--'] : pm === 'pnpm' ? ['exec'] : [])]
  const migrate = [...exec, 'caldera', 'db:migrate']
  await attempt('database', installed, [...exec, 'caldera', 'db:generate', '--', '--name', 'init'])
  // A Postgres server and its databases are yours to create: the migration is generated, and
  // applying it is left to the next steps.
  const later: string[] = []
  if (database === 'postgres') {
    report()
    const db = databaseName(name)
    later.push(`createdb ${db} && createdb ${db}_test`, migrate.join(' '))
  } else if (steps.at(-1)!.status === 'done') {
    steps.pop()
    await attempt('database', true, migrate)
    report()
  } else {
    report()
    // Not generated, so not applied either: finishing takes both.
    const step = steps.at(-1)!
    step.command = `${step.command} && ${migrate.join(' ')}`
  }
  // Next.js deploys to Vercel as it is; the Inertia app gets a function (vercel:setup) or a Worker.
  if (target !== 'node' && frontend === 'inertia') {
    await attempt('target', installed, [...exec, 'caldera', `${target}:setup`])
    report()
  }
  // Local secrets for `wrangler dev`, like .env: the same APP_KEY. Written even when the setup step is
  // left to the next steps, which don't mention it.
  if (target === 'cloudflare') {
    const key = readFileSync(join(directory, '.env'), 'utf8').match(/^APP_KEY=.*$/m)![0]
    writeFileSync(join(directory, '.dev.vars'), `${key}\n`)
  }
  const git = (options.git ?? true) && commandExists('git', env)
  if (git) {
    await attempt('git', true, ['git', 'init', '-q'])
    if (steps.at(-1)!.status === 'done') {
      steps.pop()
      await attempt('git', true, ['git', 'add', '-A'])
      if (steps.at(-1)!.status === 'done') {
        steps.pop()
        await attempt('git', true, ['git', 'commit', '-q', '-m', 'Initial commit from create-caldera'])
      }
    }
    report()
  } else {
    steps.push({ name: 'git', status: 'skipped', command: 'git init && git add -A && git commit -m "Initial commit"' })
  }

  const relative = options.directory
  const next = [
    `cd ${relative}`,
    ...steps.filter((s) => s.status !== 'done' && s.command && s.name !== 'git').map((s) => s.command!),
    ...later,
    `${run} dev`,
  ]
  return { schemaVersion: 1, directory, name, packageManager: pm, frontend, kit, teams, database, target, steps, next, log }
}

/** Runs a command, collecting its output for .create.log (never thrown: a missing program is a failed step). */
function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(command[0]!, command.slice(1), { cwd, env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('error', (error) => resolve({ status: null, output: `${output}${String(error)}` }))
    child.once('close', (status) => resolve({ status, output }))
  })
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

/**
 * Turns the shared template into the Next.js variant: Next renders pages from app/, and the Caldera
 * app (models, jobs, mail, i18n…) serves /api and is used directly from Server Components and actions.
 */
function applyNext(directory: string) {
  cpSync(TEMPLATE_NEXT, directory, { recursive: true, force: true })
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> }
  manifest.dependencies['@caldera/next'] = '^0.0.0'
  manifest.dependencies.next = '^16.4.2'
  manifest.dependencies = sorted(manifest.dependencies)
  Object.assign(manifest.scripts, { build: 'next build', start: 'next start' })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  appendFileSync(join(directory, '.gitignore'), '.next\nnext-env.d.ts\n')
  const agentsPath = join(directory, 'AGENTS.md')
  let agents = readFileSync(agentsPath, 'utf8')
  agents = agents
    .replace(/^A \[Caldera\].*$/m, 'A [Caldera](https://calderajs.dev) app with a Next.js frontend: TypeScript, Hono, Drizzle, Zod. Next renders the pages (`app/`); the Caldera app serves `/api` and does the backend work.')
    .replace(
      /^Pages get their data.*$/m,
      "Server Components and server actions use Caldera directly: `await services(app)` (db, mail, queue, cache, storage…) and `await requestContext(app)` (this request's `i18n`; add `authenticate({ required: false })` from `@caldera/auth` for `user`), both from `@caldera/next`. Models work as anywhere else. Client components call the API with the typed client: `createClient<AppType>()` from `@caldera/next/client`, with `AppType` from `src/http.ts`. `/api/*` is the Caldera app (`app/api/[[...route]]/route.ts`), with your routes from `src/routes`; `/_caldera/*` (signed file links, mail previews) is rewritten there by `next.config.ts`.",
    )
    .split('\n')
    .filter((line) => !/resources\/pages|resources\/components|src\/inertia\.ts|resources\/app\.tsx|src\/uploads\.ts|x-inertia|rootView/.test(line))
    .join('\n')
    .replace('| Providers |', '| Pages, layouts, server actions (Next.js) | `app/**` | |\n| Providers |')
    .replace(/A page lists what it needs with `export const messages[^.]*\.[^.]*\./, 'In Server Components and actions, translate with `requestContext(app)`’s `i18n`.')
    // Realtime: client components, connected by app/realtime.tsx (in the root layout).
    .replace('In pages: `useChannel(', 'In client components (app/realtime.tsx, in the root layout, connects them): `useChannel(')
    .replace("'post.updated': () => router.reload()", "'post.updated': () => router.refresh()")
  writeFileSync(agentsPath, agents)
}

const BROWSER_AGENTS =
  'Browser tests (`pnpm test:browser`, Playwright, `tests/browser/*.spec.ts`): Playwright builds the app and serves it on port 3100 (`tests/browser/server.ts`), on a database of its own that is emptied and migrated on every run (a SQLite file, or `DATABASE_TEST_URL` on Postgres). ' +
  'Open pages with `visit(page, path)` from `tests/browser/helpers.ts`, which waits for React to take over before anything is clicked. Pages connect to a realtime server of the tests’ own (port 6101), so live updates can be tested with two browsers (`browser.newContext()`). Mail sent during a test is in the outbox: `page.request.get(\'/_caldera/mail/outbox\', { headers: { accept: \'application/json\' } })`. ' +
  'Once per machine: `npx playwright install chromium`. CI (`.github/workflows/ci.yml`) runs `typecheck`, `test` and `test:browser` on every push and pull request.'

const STARTER_AGENTS =
  'Auth (the starter kit): Better Auth in `src/auth.ts`, on the app-owned users table (`src/db/schema.ts`; its own tables are in `src/db/auth-schema.ts`, regenerated by `caldera auth:schema` after changing plugins). ' +
  'Pages post to the app\'s routes (`src/routes/auth.ts`, `settings.ts`), which call `c.var.auth.api.*` with `asResponse: true` and answer with `withAuthCookies(c, res, redirect(...))` from `@caldera/auth`, so failures become `ValidationError`s on the form. ' +
  '`c.var.user` is set on every request (null for guests); named middleware in `src/middleware.ts`: `mw.auth()` (signed in, else a 401 that page visits turn into /login and back), `mw.guest()`, `mw.verified()` (with `mustVerifyEmail`), `mw.passwordConfirmed()`, `mw.signed()` (links made with `signedUrl()` from @caldera/http, for emails: no sign-in needed). ' +
  'Two-factor (Better Auth `twoFactor`: authenticator apps, recovery codes; sign-in continues at /two-factor-challenge) and passkeys (`@better-auth/passkey`: added and used in the browser through `authClient()` from `resources/lib/auth-client.ts`, which talks to /api/auth) are both on; Security settings manages them. ' +
  'Settings are in `src/config/auth.ts` (`home`, `mustVerifyEmail`, `twoFactor`, `passkeys`, `passwordTimeoutSeconds`), read as `c.var.config.auth`. Reset and verification emails are `src/mail/reset-password.tsx` and `verify-email.tsx`; in development they land in the outbox (/_caldera/mail/outbox). ' +
  'Layouts: `resources/layout.ts` picks one per page; `resources/layouts/app-layout.tsx` and `auth-layout.tsx` each re-export one variant (header with tabs, the default, or sidebar; split, the default, simple or card), so switching is one line. Pages sit in a gray panel (`bg-surface`) as white cards; settings use `Section` (`resources/components/section.tsx`). Colors are CSS variables in `resources/app.css` (the kit\'s look is the last `:root`/`.dark` block: blue `--ring`/`--link`, `--surface`). Pages pass layout props with `Page.layout = { breadcrumbs: [...] }` (auth pages: `{ title, description }`). Navigation items are in `resources/components/navigation.ts` (`mainNavItems`, the tabs; `settingsNavItems`, the settings pages); the command menu (`resources/components/command-menu.tsx`, ⌘K or Ctrl+K, and the search button in the header) lists them, with appearance and log out: add entries to its `sections`. ' +
  'Branding: the logo is Caldera\'s until you replace it: `resources/components/app-logo-icon.tsx` (the mark, in the header and sign-in pages), `caldera-logo.tsx` (the mark and name, in the footer and sign-in pages), `welcome-art.tsx` (the poster on the welcome page and beside the sign-in forms) and `public/favicon.svg`. Colours are CSS variables in `resources/app.css` (`--primary` is the brand blue). ' +
  'Feedback: both app layouts show toasts (`resources/components/flash-toasts.tsx`): `back(c).with(\'success\', \'Saved.\')` or `.with(\'error\', …)` from any route shows one; pages answered with a status code show theirs with `useStatusToast({ \'profile-updated\': \'Profile saved.\' })`. Avatars without a picture use `avatarColor(name)` from `resources/lib/avatar-color.ts` (the same colour for the same name). ' +
  'Authorization: `c.var.gate` checks the policies in `src/policies` (`caldera make:policy <Model>`; everything is denied until you allow it). `caldera generate` lists them in `.caldera/policies.gen.ts`, which `src/app.ts` passes to `authorizationProvider({ policies })`. On a route: `authorize: allows(Post, \'update\', \'post\')` (after `bind: { post: Post }`); in a handler: `await c.var.gate.authorize(Post, \'create\')` or `c.var.gate.can(...)`; for pages, `c.var.gate.annotate(Post, rows, [\'update\'])` adds `can` booleans to each row. ' +
  'Tests create users with `createUser(t)` from `tests/helpers.ts` (through Better Auth) and sign in with `await t.client(http).actingAs(user)`, or `actingAsConfirmed(t, user)` for pages behind `mw.passwordConfirmed()` (Security, and adding or removing passkeys; signing in with the password, or using a passkey, counts as confirming it, and /confirm-password offers the person\'s passkey). ' +
  'Browser tests sign up with `register(page)`, log out with `logOut(page, name)` and use passkeys through `virtualAuthenticator(context, page)` (Chrome\'s virtual authenticator), all from `tests/browser/helpers.ts`.'

const TEAMS_AGENTS =
  'Teams (Better Auth organizations, `src/teams.ts`): everyone gets a personal team at registration (it can\'t be deleted, left or shared); the current team is the session\'s active organization (`c.var.authSession.activeOrganizationId`), switched with the team switcher (`resources/components/team-switcher.tsx`: at the top of the sidebar, or next to the logo in the header layout; POST /teams/switch). ' +
  'New teams come from a one-field dialog (`openNewTeamDialog()` from `resources/components/new-team-dialog.tsx`, in the switcher, the command menu and Settings → Teams). Settings → Teams (`src/routes/teams.ts`): create, rename and delete teams, invite by email (`src/mail/team-invitation.tsx`, accepted at /invitations/:id), change roles, remove members, hand the team to another member (they become owner, the owner an admin), leave. ' +
  'Roles and what they may do are in `src/roles.ts` (Better Auth access control: add your own resources there); policies check them with `g.org.id` (the current team) and `await g.org.has({ project: [\'create\'] })`. Scope a team\'s data by a `teamId` column and the current team, and check `g.org.id` in policies.'

const NEXT_TEAMS_AGENTS =
  'Teams (Better Auth organizations, `src/teams.ts`): everyone gets a personal team at registration (it can\'t be deleted, left or shared); the current team is the session\'s active organization (`c.var.authSession.activeOrganizationId`), switched with the team switcher (`components/team-switcher.tsx`: next to the logo in the header layout, at the top of the sidebar in the other). ' +
  '`app/(app)/layout.tsx` loads the person\'s teams (GET /api/teams/current) and gives them to the switcher, the command menu and the pages through `TeamsProvider` (`useTeams()`). New teams come from a one-field dialog (`openNewTeamDialog()` from `components/new-team-dialog.tsx`). Settings → Teams (`app/(app)/settings/teams`, data and changes in `src/routes/teams.ts`, server actions in `app/actions/teams.ts`): create, rename and delete teams, invite by email (`src/mail/team-invitation.tsx`, accepted at /invitations/:id), change roles, remove members, hand the team to another member, leave. ' +
  'Roles and what they may do are in `src/roles.ts` (Better Auth access control: add your own resources there); policies check them with `g.org.id` (the current team) and `await g.org.has({ project: [\'create\'] })`. Scope a team\'s data by a `teamId` column and the current team, and check `g.org.id` in policies.'

/** Teams over the starter: Better Auth's organization plugin, the gate's `g.org`, the switcher and settings. */
function applyTeams(directory: string, database: Database) {
  copyLayer(STARTER_TEAMS, directory)
  addTeams(directory, database)
  edit(directory, 'src/inertia.ts', [
    ["import { getCookie } from 'hono/cookie'\n", "import { getCookie } from 'hono/cookie'\nimport { teamsFor } from './teams.js'\n"],
    ['    // The signed-in user (or null), for the layouts and pages.\n', '    // The person\'s teams and the current one, for the team switcher (src/teams.ts).\n    teams: () => teamsFor(c),\n    // The signed-in user (or null), for the layouts and pages.\n'],
  ])
  edit(directory, 'resources/components/app-sidebar.tsx', [
    ["import { AppLogo } from '@/components/app-logo'\n", ''],
    ["import { UserInfo } from '@/components/user-info'\n", "import { TeamSwitcher } from '@/components/team-switcher'\nimport { UserInfo } from '@/components/user-info'\n"],
    [/            <SidebarMenuButton size="lg" render=\{<Link href="\/dashboard" prefetch \/>\}>\n              <AppLogo \/>\n            <\/SidebarMenuButton>\n/, '            <TeamSwitcher />\n'],
  ])
  teamNavigation(directory, 'resources/components')
  edit(directory, 'AGENTS.md', [[/^Tests \(`pnpm test`/m, `${TEAMS_AGENTS}\n\nTests (\`pnpm test\``]])
}

/** Teams in the Next.js starter: the same server side, Next pages, and the switcher fed by app/(app)/layout.tsx. */
function applyNextTeams(directory: string, database: Database) {
  const kits = fileURLToPath(KITS_DIR)
  // From the Inertia teams layer, unchanged: Better Auth's organizations, roles, the invitation email, the tables.
  for (const file of ['src/teams.ts', 'src/roles.ts', 'src/mail/team-invitation.tsx', 'src/db/schema.ts', 'src/db/auth-schema.ts']) {
    cpSync(join(kits, 'starter-teams', file), join(directory, file))
  }
  copyLayer(NEXT_STARTER_TEAMS, directory)
  addTeams(directory, database)
  edit(directory, 'components/app-sidebar.tsx', [
    ["import { AppLogo } from '@/components/app-logo'\n", ''],
    ["import { UserInfo, type UserSummary } from '@/components/user-info'\n", "import { TeamSwitcher } from '@/components/team-switcher'\nimport { UserInfo, type UserSummary } from '@/components/user-info'\n"],
    [/            <SidebarMenuButton size="lg" render=\{<Link href="\/dashboard" \/>\}>\n              <AppLogo \/>\n            <\/SidebarMenuButton>\n/, '            <TeamSwitcher />\n'],
  ])
  teamNavigation(directory, 'components')
  edit(directory, 'AGENTS.md', [[/^Tests \(`pnpm test`/m, `${NEXT_TEAMS_AGENTS}\n\nTests (\`pnpm test\``]])
}

/** Both variants: the organization plugin in src/auth.ts, `g.org` for policies, and the teams' tables for Postgres. */
function addTeams(directory: string, database: Database) {
  if (database === 'postgres') cpSync(STARTER_TEAMS_POSTGRES, directory, { recursive: true, force: true })
  edit(directory, 'src/auth.ts', [
    ["import { User } from './models/user.js'\n", "import { User } from './models/user.js'\nimport { teamHooks, teamsPlugin } from './teams.js'\n"],
    ['      // Both are always installed', '      // A personal team for every account; new sessions start in their first team (src/teams.ts).\n      databaseHooks: teamHooks(db),\n      // Both are always installed'],
    ['      plugins: [\n', '      plugins: [\n        // Teams: Better Auth organizations, with the roles in src/roles.ts.\n        teamsPlugin({ appUrl: env.APP_URL }),\n'],
  ])
  edit(directory, 'src/app.ts', [
    ["import { auth } from './auth.js'\n", "import { organizationGate } from '@caldera/auth/organization'\nimport { auth } from './auth.js'\nimport { roles } from './roles.js'\n"],
    [
      '    // c.var.gate: checks against the policies in src/policies (listed by `caldera generate`).\n    authorizationProvider({ policies }),\n',
      '    // c.var.gate: checks against the policies in src/policies (listed by `caldera generate`), with\n    // g.org: the current team and the person\'s role in it (src/roles.ts).\n    authorizationProvider({ policies, extend: organizationGate({ roles }) }),\n',
    ],
  ])
}

/** The switcher in the header, a Teams section in the command menu, and Settings → Teams. */
function teamNavigation(directory: string, components: string) {
  edit(directory, `${components}/app-header.tsx`, [
    ["import { Button } from '@/components/ui/button'\n", "import { HeaderTeamSwitcher } from '@/components/team-switcher'\nimport { Button } from '@/components/ui/button'\n"],
    ['          <AppLogo />\n        </Link>\n', '          <AppLogo />\n        </Link>\n        <HeaderTeamSwitcher />\n'],
  ])
  edit(directory, `${components}/command-menu.tsx`, [
    ["import { footerNavItems, mainNavItems, settingsNavItems } from '@/components/navigation'\n", "import { footerNavItems, mainNavItems, settingsNavItems } from '@/components/navigation'\nimport { useTeamCommands } from '@/components/team-switcher'\n"],
    ['  const [mac, setMac] = useState(true)\n', '  const [mac, setMac] = useState(true)\n  const teams = useTeamCommands()\n'],
    [/(    \{ value: 'Pages', .*\n)/, `$1    // Switch to another team, or make one (${components}/team-switcher.tsx).\n    teams,\n`],
  ])
  edit(directory, `${components}/navigation.ts`, [["  { title: 'Security', href: '/settings/security' },\n", "  { title: 'Security', href: '/settings/security' },\n  { title: 'Teams', href: '/settings/teams' },\n"]])
}

/** The starter kit's sign-in (src/auth.ts) as a provider of the app, and its tables for Postgres. */
function applyStarter(directory: string, database: Database) {
  addAuth(directory, database)
  edit(directory, 'AGENTS.md', [[/^Tests \(`pnpm test`/m, `${STARTER_AGENTS}\n\nTests (\`pnpm test\``]])
}

/** Better Auth and the gate as providers of the app (src/app.ts), and Better Auth's tables for Postgres. */
function addAuth(directory: string, database: Database) {
  edit(directory, 'src/app.ts', [
    ["import { env } from './env.js'\n", "import { authorizationProvider } from '@caldera/auth'\nimport { auth } from './auth.js'\nimport { env } from './env.js'\n"],
    ["import { notifications } from '../.caldera/notifications.gen.js'\n", "import { notifications } from '../.caldera/notifications.gen.js'\nimport { policies } from '../.caldera/policies.gen.js'\n"],
    [
      '  providers: [\n',
      '  providers: [\n    // Sign-in, sessions and passwords (Better Auth): c.var.auth, and c.var.user on every request.\n    auth,\n    // c.var.gate: checks against the policies in src/policies (listed by `caldera generate`).\n    authorizationProvider({ policies }),\n',
    ],
  ])
  if (database === 'postgres') {
    cpSync(STARTER_POSTGRES, directory, { recursive: true, force: true })
    edit(directory, 'src/auth.ts', [["provider: 'sqlite'", "provider: 'pg'"]])
  }
}

// From the Inertia kits, unchanged: the coss ui components (made client components), and the kit's
// own components, hooks and helpers that don't use Inertia. `true`: a client component.
const NEXT_SHARED: [from: string, to: string, client: boolean][] = [
  ['blank/resources/components/appearance-tabs.tsx', 'components/appearance-tabs.tsx', true],
  ['starter/resources/components/appearance-picker.tsx', 'components/appearance-picker.tsx', true],
  ['starter/resources/components/one-time-code.tsx', 'components/one-time-code.tsx', true],
  ...['app-footer', 'app-logo-icon', 'caldera-logo', 'form-field', 'heading', 'section', 'user-info', 'welcome-art'].map(
    (name) => [`starter/resources/components/${name}.tsx`, `components/${name}.tsx`, false] as [string, string, boolean],
  ),
  ['blank/resources/hooks/use-media-query.ts', 'hooks/use-media-query.ts', true],
  ['blank/resources/lib/utils.ts', 'lib/utils.ts', false],
  ['starter/resources/lib/auth-client.ts', 'lib/auth-client.ts', false],
  ['starter/resources/lib/avatar-color.ts', 'lib/avatar-color.ts', false],
  // The theme (Tailwind and coss ui's colors), and the tab icon.
  ['blank/resources/app.css', 'app/app.css', false],
  ['blank/public/favicon.svg', 'public/favicon.svg', false],
  // Sign-in on the server: Better Auth, its settings, tables and emails.
  ['starter/src/auth.ts', 'src/auth.ts', false],
  ['starter/src/config/auth.ts', 'src/config/auth.ts', false],
  ['starter/src/db/schema.ts', 'src/db/schema.ts', false],
  ['starter/src/db/auth-schema.ts', 'src/db/auth-schema.ts', false],
  ['starter/src/mail/reset-password.tsx', 'src/mail/reset-password.tsx', false],
  ['starter/src/mail/verify-email.tsx', 'src/mail/verify-email.tsx', false],
  // Browser tests that need no change.
  ['starter/tests/totp.ts', 'tests/totp.ts', false],
  ['starter/tests/browser/helpers.ts', 'tests/browser/helpers.ts', false],
  ['starter/tests/browser/command-menu.spec.ts', 'tests/browser/command-menu.spec.ts', false],
  ['blank/tests/browser/appearance.spec.ts', 'tests/browser/appearance.spec.ts', false],
]

/**
 * The starter kit for Next.js: the Inertia starter's pages as Next pages (app/), the same components,
 * and the same routes answering in JSON, called from server actions (`submit`) and pages (`load`).
 */
function applyNextStarter(directory: string, database: Database) {
  const kits = fileURLToPath(KITS_DIR)
  // The demo page's files; the kit has its own home page.
  for (const file of ['app/hello.tsx', 'app/sign-up.tsx', 'app/actions.ts', 'app/globals.css']) rmSync(join(directory, file), { force: true })
  mkdirSync(join(directory, 'components/ui'), { recursive: true })
  for (const kit of ['blank', 'starter']) {
    const ui = join(kits, kit, 'resources/components/ui')
    for (const file of readdirSync(ui)) writeFileSync(join(directory, 'components/ui', file), asClient(readFileSync(join(ui, file), 'utf8')))
  }
  for (const [from, to, client] of NEXT_SHARED) {
    mkdirSync(join(directory, to, '..'), { recursive: true })
    const text = readFileSync(join(kits, from))
    writeFileSync(join(directory, to), client ? asClient(text.toString('utf8')) : text)
  }
  // Next reads src/middleware.ts as its own middleware, so the routes' named middleware is src/route-middleware.ts.
  edit(directory, 'src/auth.ts', [["import { confirmPassword } from './middleware.js'", "import { confirmPassword } from './route-middleware.js'"]])
  copyLayer(NEXT_STARTER, directory)
  addAuth(directory, database)
  edit(directory, 'AGENTS.md', [[/^Tests \(`pnpm test`/m, `${NEXT_STARTER_AGENTS}\n\nTests (\`pnpm test\``]])
}

/** Marks a component as a client component (Next.js); Vite doesn't need it. */
function asClient(text: string): string {
  return text.startsWith("'use client'") ? text : `'use client'\n\n${text}`
}

const NEXT_STARTER_AGENTS =
  'Auth (the starter kit): Better Auth in `src/auth.ts`, on the app-owned users table (`src/db/schema.ts`; its own tables are in `src/db/auth-schema.ts`, regenerated by `caldera auth:schema` after changing plugins). ' +
  'The routes do the work, as JSON (`src/routes/auth.ts`, `settings.ts`, `dashboard.ts`), and the pages call them: a page loads its data with `await load(http, \'/settings/security\')` from `@caldera/next` (the route runs as the browser\'s request, with its middleware: its redirect is Next\'s, a 401 goes to /login?redirect=… and back, a 404 is `notFound()`); a form calls a server action in `app/actions/*.ts`, which posts to the route with `submit(http, \'/login\', data)` (the route\'s cookies are set, its redirect is Next\'s, its validation errors come back for the form). Forms use `useForm` from `@caldera/next/client` (`data`, `setData`, `errors`, `processing`, `submit(action)`). ' +
  '`c.var.user` is set on every request (null for guests); named middleware in `src/route-middleware.ts` (not src/middleware.ts: Next.js reads that as its own): `mw.auth()`, `mw.guest()`, `mw.verified()` (with `mustVerifyEmail`), `mw.passwordConfirmed()` (to /confirm-password?redirect=… and back), `mw.signed()` (links made with `signedUrl()`). Sign-in pages pass `?redirect=` on as a `redirect` field; `intendedPage(c, to, fallback)` follows it, only to this site. ' +
  'In Server Components, `lib/caldera.ts` gives `context()` (user, session, gate, i18n), `currentUser()`, `requireUser()`, `requireGuest()` and `flash()`. Rendering can\'t set cookies: a page shows what a route flashed (`back(c).with(\'success\', …)` as a toast in the app layouts, `status` on the page), then `components/flash-toasts.tsx` clears it. `proxy.ts` tells pages their own path (`x-pathname`). ' +
  'Two-factor (Better Auth `twoFactor`) and passkeys (`@better-auth/passkey`, through `authClient()` from `lib/auth-client.ts`, which talks to /api/auth) are both on; Security settings manages them. Settings are in `src/config/auth.ts` (`home`, `mustVerifyEmail`, `twoFactor`, `passkeys`, `passwordTimeoutSeconds`). ' +
  'Layouts: `app/(auth)` and `app/(app)` (the signed-in pages); `layouts/app-layout.tsx` and `auth-layout.tsx` each re-export one variant (header with tabs, the default, or sidebar; split, the default, simple or card). Components are in `components/` (coss ui in `components/ui`: client components), navigation in `components/navigation.ts`, the command menu (⌘K) in `components/command-menu.tsx`. Colors are CSS variables in `app/app.css`. ' +
  'Authorization: `c.var.gate` in routes, `(await context()).gate` in pages, against the policies in `src/policies` (`caldera make:policy <Model>`). ' +
  'Tests call the routes under /api (`await t.client(http).actingAs(user)`, `createUser(t)` from `tests/helpers.ts`); browser tests sign up with `register(page)` and use passkeys through `virtualAuthenticator(context, page)` (`tests/browser/helpers.ts`).'

/**
 * Copies a layer over the app. Its package.json isn't copied but merged: its dependencies,
 * devDependencies and scripts are added to the app's.
 */
function copyLayer(layer: URL, directory: string) {
  const manifestFile = join(fileURLToPath(layer), 'package.json')
  cpSync(layer, directory, { recursive: true, force: true, filter: (source) => resolve(source) !== resolve(manifestFile) })
  if (!existsSync(manifestFile)) return
  const added = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, Record<string, string>>
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, Record<string, string>>
  for (const field of ['dependencies', 'devDependencies'] as const) if (added[field]) manifest[field] = sorted({ ...manifest[field], ...added[field] })
  if (added.scripts) manifest.scripts = { ...manifest.scripts, ...added.scripts }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** `from './app.js'` → `from './app'` in every TypeScript file (the templates are written NodeNext-style). */
function extensionlessImports(directory: string) {
  for (const file of listFiles(directory)) {
    if (!/\.tsx?$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    const stripped = text.replace(/((?:from|import)\s*\(?\s*'\.{1,2}\/[^']+)\.js'/g, "$1'")
    if (stripped !== text) writeFileSync(file, stripped)
  }
}

/**
 * Postgres instead of libSQL: the layer's schema, Caldera's tables and drizzle config, then the
 * connection (node-postgres), env and dependencies. Each edit must find its text, so a changed
 * template fails here (and in the tests) rather than leaving a half-SQLite app.
 */
function applyPostgres(directory: string, name: string) {
  const db = databaseName(name)
  edit(directory, 'src/app.ts', [
    ["import { drizzle as d1 } from 'drizzle-orm/d1'\nimport { drizzle } from 'drizzle-orm/libsql'\n", "import { drizzle } from 'drizzle-orm/node-postgres'\n"],
    [
      /    \/\/ libSQL \(DATABASE_URL\).*\n(?:    \/\/.*\n)*    databaseProvider\(\{\n.*\n.*\n    \}\),\n/,
      "    // Postgres (DATABASE_URL), through node-postgres's connection pool.\n    databaseProvider({\n      driver: 'postgres',\n      connect: (app) => drizzle({ connection: app.config.database.url, relations }),\n    }),\n",
    ],
  ])
  edit(directory, 'src/env.ts', [
    ["DATABASE_URL: z.string().default('file:local.db'),", `DATABASE_URL: z.string().default('postgres://localhost:5432/${db}'),`],
    [/  \/\/ For a hosted libSQL database.*\n  DATABASE_AUTH_TOKEN: .*\n/, ''],
  ])
  edit(directory, '.env.example', [
    [/DATABASE_URL=file:local\.db\n# Turso.*\nDATABASE_AUTH_TOKEN=\n/, `DATABASE_URL=postgres://localhost:5432/${db}\n# Tests reset this database (its name must contain "test").\nDATABASE_TEST_URL=postgres://localhost:5432/${db}_test\n`],
  ])
  edit(directory, 'README.md', [['(SQLite by default: local.db)', `(Postgres: ${db})`]])
  // Every test file resets the one test database (SQLite gives each file its own), so files run one
  // at a time, as Laravel's tests do without --parallel.
  const vitestConfig = join(directory, 'vitest.config.ts')
  if (!existsSync(vitestConfig)) writeFileSync(vitestConfig, POSTGRES_VITEST_CONFIG)
  else if (readFileSync(vitestConfig, 'utf8').includes('test: { ')) {
    edit(directory, 'vitest.config.ts', [
      ['export default', '// Test files share the Postgres test database (DATABASE_TEST_URL), which each one resets: one at a time.\nexport default'],
      ['test: { ', 'test: { fileParallelism: false, '],
    ])
  } else edit(directory, 'vitest.config.ts', [['export default defineConfig({ ', 'export default defineConfig({ test: { fileParallelism: false }, ']])
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, Record<string, string>>
  delete manifest.dependencies!['@libsql/client']
  manifest.dependencies = sorted({ ...manifest.dependencies, pg: '^8.23.1' })
  manifest.devDependencies = sorted({ ...manifest.devDependencies, '@types/pg': '^8.23.1' })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const POSTGRES_VITEST_CONFIG = `import { defineConfig } from 'vitest/config'

// Test files share the Postgres test database (DATABASE_TEST_URL), which each one resets: one at a time.
export default defineConfig({ test: { fileParallelism: false } })
`

/**
 * GitHub Actions for a kit app: types, tests and browser tests on every push and pull request, with
 * the package manager the app was made with (and a Postgres service for Postgres apps).
 */
function ciWorkflow(pm: PackageManager, run: string, database: Database, name: string, version: string | undefined): string {
  const install = { pnpm: 'pnpm install --frozen-lockfile', npm: 'npm ci', yarn: 'yarn install --frozen-lockfile', bun: 'bun install --frozen-lockfile' }[pm]
  const testDatabase = `${databaseName(name)}_test`
  const lines = [
    'name: CI',
    '',
    'on:',
    '  push:',
    // `git init`'s default branch is either, depending on the machine.
    '    branches: [main, master]',
    '  pull_request:',
    '',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    ...(database === 'postgres'
      ? [
          '    services:',
          '      postgres:',
          '        image: postgres:17',
          '        env:',
          '          POSTGRES_PASSWORD: postgres',
          `          POSTGRES_DB: ${testDatabase}`,
          '        ports: ["5432:5432"]',
          '        options: --health-cmd pg_isready --health-interval 5s --health-timeout 5s --health-retries 10',
          '    env:',
          '      # Tests and the browser tests reset this database; its name must contain "test".',
          `      DATABASE_TEST_URL: postgres://postgres:postgres@localhost:5432/${testDatabase}`,
        ]
      : []),
    '    steps:',
    '      - uses: actions/checkout@v5',
    // pnpm/action-setup reads the version from package.json's packageManager when it's there.
    ...(pm === 'pnpm' ? ['      - uses: pnpm/action-setup@v4', ...(version ? [] : ['        with:', '          version: 11'])] : []),
    ...(pm === 'bun' ? ['      - uses: oven-sh/setup-bun@v2'] : []),
    '      - uses: actions/setup-node@v5',
    '        with:',
    '          node-version: 24',
    // Yarn 2+ (package.json's packageManager) comes from corepack; the runner's global Yarn is 1.x.
    ...(pm === 'bun' || pm === 'yarn' ? [] : [`          cache: ${pm}`]),
    ...(pm === 'yarn' ? ['      - run: corepack enable'] : []),
    `      - run: ${install}`,
    `      - run: ${run} typecheck`,
    `      - run: ${run} test`,
    '      - run: npx playwright install --with-deps chromium',
    `      - run: ${run} test:browser`,
    '      - uses: actions/upload-artifact@v4',
    '        if: failure()',
    '        with:',
    '          name: playwright-report',
    '          path: playwright-report/',
    '          retention-days: 7',
  ]
  return `${lines.join('\n')}\n`
}

/** Replaces text in a created file; each pattern must match. */
function edit(directory: string, file: string, edits: [string | RegExp, string][]) {
  const path = join(directory, file)
  let text = readFileSync(path, 'utf8')
  for (const [pattern, replacement] of edits) {
    const found = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
    if (!found) throw new CreateError('template_missing', `The template's ${file} has changed: can't find ${String(pattern)}.`)
    text = text.replace(pattern, replacement)
  }
  writeFileSync(path, text)
}

/** A Postgres database name from the package name: my-app → my_app. */
function databaseName(name: string): string {
  return name.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'app'
}

function sorted(record: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}
