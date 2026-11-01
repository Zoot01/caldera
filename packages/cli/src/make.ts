import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CalderaError } from '@caldera-js/core'
import { generate } from './codegen.js'
import { names, render, singularize, type Names } from './names.js'
import { CONVENTIONS, type Project } from './project.js'
import { STUBS, type StubName } from './stubs.js'

export const MAKE_KINDS = ['model', 'policy', 'factory', 'seeder', 'routes', 'config', 'provider', 'page', 'job', 'event', 'listener', 'schedule', 'mail', 'notification', 'channel'] as const
export type MakeKind = (typeof MAKE_KINDS)[number]

interface Planned {
  path: string
  stub: StubName
  /** Written only when missing: an existing file is used as is. */
  keep?: boolean
}

/** Where each kind of file goes. These paths are the conventions codegen and agents rely on. */
function plan(kind: MakeKind, n: Names & { page: string; id: string }, project: Project, options: { table: boolean; channel: boolean }): Planned[] {
  switch (kind) {
    case 'model':
      return [
        ...(options.table ? [{ path: `src/db/tables/${n.kebab}.ts`, stub: dialectOf(project) === 'sqlite' ? 'table-sqlite' : 'table' } as Planned] : []),
        { path: `${CONVENTIONS.modelsDir}/${n.kebab}.ts`, stub: 'model' },
      ]
    case 'policy':
      return [{ path: `${CONVENTIONS.policiesDir}/${n.kebab}.ts`, stub: 'policy' }]
    case 'factory':
      return [{ path: `src/db/factories/${n.kebab}.ts`, stub: 'factory' }]
    case 'seeder':
      return [{ path: `${CONVENTIONS.seedersDir}/${n.kebab}.ts`, stub: 'seeder' }]
    case 'routes':
      return [{ path: `${CONVENTIONS.routesDir}/${channelName(n)}.ts`, stub: 'routes' }]
    case 'config':
      return [{ path: `${CONVENTIONS.configDir}/${n.kebab}.ts`, stub: 'config' }]
    case 'provider':
      return [{ path: `src/providers/${n.kebab}.ts`, stub: 'provider' }]
    case 'page':
      return [{ path: `${CONVENTIONS.pagesDir}/${n.page}.tsx`, stub: 'page' }]
    case 'job':
      return [{ path: `${CONVENTIONS.jobsDir}/${n.kebab}.ts`, stub: 'job' }]
    case 'event':
      return [{ path: `${CONVENTIONS.eventsDir}/${n.kebab}.ts`, stub: options.channel ? 'event-broadcast' : 'event' }]
    case 'listener':
      return [{ path: `${CONVENTIONS.listenersDir}/${n.kebab}.ts`, stub: 'listener' }]
    case 'schedule':
      return [{ path: `${CONVENTIONS.schedulesDir}/${n.kebab}.ts`, stub: 'schedule' }]
    case 'mail':
      return [{ path: `${CONVENTIONS.mailDir}/${n.kebab}.tsx`, stub: 'mail' }]
    case 'notification':
      // With its mail, which the stub sends on the mail channel (kept if it's already there).
      return [
        { path: `${CONVENTIONS.notificationsDir}/${n.kebab}.ts`, stub: 'notification' },
        { path: `${CONVENTIONS.mailDir}/${n.kebab}.tsx`, stub: 'mail', keep: true },
      ]
    case 'channel':
      // Bound to the model of the same name when there is one, checked by its policy.
      return [{ path: `${CONVENTIONS.channelsDir}/${n.kebab}.ts`, stub: hasModel(project, n) ? 'channel-model' : 'channel' }]
  }
}

function dependsOn(project: Project, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(project.path('package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
    return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
  } catch {
    return false
  }
}

/** Next steps generators print instead of editing files you own. */
function hints(kind: MakeKind, n: Names & { page: string; id: string }, options: { table: boolean; channel: boolean; presence: boolean; faker: boolean }): string[] {
  // Factories use faker, an optional peer of @caldera-js/db that apps don't have until they need it.
  if (kind === 'factory' && !options.faker) return ['Factories use faker: `pnpm add -D @faker-js/faker`.']
  if (kind === 'model' && options.table) {
    return [`Add \`${n.plural}\` (from src/db/tables/${n.kebab}.ts) to defineRelations in ${CONVENTIONS.relations}, then run \`caldera db:generate\`.`]
  }
  if (kind === 'model' && !options.table) return [`Point the import in ${CONVENTIONS.modelsDir}/${n.kebab}.ts at your existing \`${n.plural}\` table.`]
  if (kind === 'provider') return [`Add \`${n.name}Provider\` to the providers in ${CONVENTIONS.app}.`]
  if (kind === 'mail') return [`Send it: \`await mail.to(user).send(${n.Name}Email, { url })\` from '@caldera-js/mail'. Preview: /_caldera/mail/${n.id}.`]
  if (kind === 'notification') {
    return [
      `Send it: \`await notify(user, ${n.Name}, { id })\` from '@caldera-js/notifications'. It emails ${CONVENTIONS.mailDir}/${n.kebab}.tsx (preview: /_caldera/mail/${n.id}) and stores a row for the inbox, which needs \`caldera notifications:table\`.`,
    ]
  }
  if (kind === 'schedule') return [`\`caldera schedule:list\` shows its next run; \`caldera schedule:work\` (or a platform cron, see \`caldera schedule:sync\`) runs it.`]
  if (kind === 'event') {
    return [
      `Emit it with \`await emit(${n.Name}, { ... })\` from '@caldera-js/events'; add listeners with \`caldera make:listener <Name> --event ${n.Name}\`.${options.channel ? ' Its payload names the channel\'s parameter: if the channel calls it something else, change both.' : ' To send it to browsers too, make it with --channel <Channel>.'}`,
    ]
  }
  if (kind === 'listener') return [`It runs on every emit of its event. For slow work, listen with a job instead: \`listen(Event, Job.fromEvent((e) => ({ ... })))\`.`]
  if (kind === 'job') return [`Dispatch it with \`await dispatch(${n.Name}, { id })\` from '@caldera-js/queue'; \`caldera queue:work\` runs it.`]
  if (kind === 'channel') {
    const pattern = `${channelName(n)}.{${n.name}}`
    return [
      `Send events on it: \`caldera make:event ${n.Name}Updated --channel ${n.Name}\`. In a page: \`${options.presence ? `const { members } = usePresence` : 'useChannel'}('${pattern}', { ${n.name}: ${n.name}.id }, { on: { ... } })\` from '@caldera-js/broadcast/react'.`,
    ]
  }
  if (kind === 'page') return [`Render it from a route: \`c.render('${n.page}', { title: '${n.Name}' })\`.`]
  return []
}

/** A channel's name: the plural, kebab-cased (`BlogPost` → `blog-posts`, for `blog-posts.{blogPost}`). */
const channelName = (n: Names) => n.table.replaceAll('_', '-')

/** Event names are dotted, the subject then what happened: `OrderShipped` → `order.shipped`. */
function eventName(n: Names): string {
  const words = n.kebab.split('-')
  return words.length < 2 ? n.kebab : `${words.slice(0, -1).join('-')}.${words.at(-1)}`
}

/** Job names are dotted too, what it acts on then the action: `SendDigest` → `digest.send`, `PruneUploads` → `uploads.prune`. */
function jobName(n: Names): string {
  const words = n.kebab.split('-')
  return words.length < 2 ? n.kebab : `${words.slice(1).join('-')}.${words[0]}`
}

/** `DailyDigest` → `Daily digest`: for text people read (a mail's heading). */
const title = (n: Names) => n.kebab.split('-').map((word, i) => (i === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(' ')

/** Whether `src/models/<name>.ts` exports a model of that name. */
function hasModel(project: Project, n: Names): boolean {
  const file = project.path(`${CONVENTIONS.modelsDir}/${n.kebab}.ts`)
  return existsSync(file) && new RegExp(`export const ${n.Name}\\b`).test(readFileSync(file, 'utf8'))
}

export function dialectOf(project: Project): 'pg' | 'sqlite' {
  const file = project.path('drizzle.config.ts')
  if (!existsSync(file)) return 'pg'
  return /dialect:\s*['"](sqlite|turso)['"]/.test(readFileSync(file, 'utf8')) ? 'sqlite' : 'pg'
}

/** The app's own copy (`stubs/<name>.stub`) wins over the built-in one. */
export function resolveStub(project: Project, stub: StubName): { source: 'app' | 'built-in'; template: string } {
  const own = project.path(`stubs/${stub}.stub`)
  return existsSync(own) ? { source: 'app', template: readFileSync(own, 'utf8') } : { source: 'built-in', template: STUBS[stub] }
}

export interface MakeResult {
  schemaVersion: 1
  kind: MakeKind
  created: string[]
  hints: string[]
  /** Result of the follow-up `caldera generate`; failures here never undo the created files. */
  generate: 'ok' | 'skipped' | { error: string }
  /** With `dryRun`: what would be written, and nothing is. */
  planned?: { path: string; contents: string; exists: boolean }[]
}

export async function make(
  project: Project,
  kind: MakeKind,
  rawName: string,
  options: { force?: boolean; table?: boolean; event?: string; job?: string; channel?: string; presence?: boolean; dryRun?: boolean } = {},
): Promise<MakeResult> {
  let n: Names & { page: string; id: string }
  try {
    // Pages are paths (`Posts/Index`): each segment is a PascalCase folder or file name.
    const segments = kind === 'page' ? rawName.split('/').filter(Boolean).map((segment) => names(segment).Name) : []
    // Mails and notifications take a namespace for their stable id: `billing.InvoicePaid` → `billing.invoice-paid`.
    const dot = kind === 'mail' || kind === 'notification' ? rawName.lastIndexOf('.') : -1
    const namespace = dot > 0 ? names(rawName.slice(0, dot)).kebab : undefined
    // Routes are for a resource: `notes` and `Note` both make src/routes/notes.ts, at /notes.
    const raw = kind === 'routes' ? names(rawName).kebab.replace(/[^-]+$/, singularize) : rawName
    const base = names(kind === 'page' ? (segments.at(-1) ?? '') : dot > 0 ? raw.slice(dot + 1) : raw)
    n = { ...base, page: segments.join('/'), id: namespace ? `${namespace}.${base.kebab}` : base.kebab }
  } catch (error) {
    throw new CalderaError('invalid_name', (error as Error).message)
  }
  const table = options.table ?? true
  const flags = {
    table,
    channel: kind === 'event' && Boolean(options.channel),
    presence: kind === 'channel' && Boolean(options.presence),
    faker: kind === 'factory' && dependsOn(project, '@faker-js/faker'),
  }
  const files = plan(kind, n, project, flags).filter((f) => !(f.keep && existsSync(project.path(f.path))))
  const existing = files.filter((f) => existsSync(project.path(f.path))).map((f) => f.path)
  if (existing.length > 0 && !options.force) {
    throw new CalderaError('file_exists', `Refusing to overwrite ${existing.join(', ')}. Pass --force to replace.`, { files: existing })
  }
  if (kind === 'listener' && !options.event) {
    throw new CalderaError('missing_argument', 'Missing --event. Usage: caldera make:listener <Name> --event <EventName>', { missing: ['event'] })
  }
  if (kind === 'schedule' && !options.job) {
    throw new CalderaError('missing_argument', 'Missing --job. Usage: caldera make:schedule <Name> --job <JobName>', { missing: ['job'] })
  }
  const eventNames = options.event ? names(options.event) : undefined
  const jobNames = options.job ? names(options.job) : undefined
  const channelNames = flags.channel ? names(options.channel!.replace(/Channel$/, '')) : undefined
  const values = {
    ...n,
    eventName: eventName(n),
    jobName: jobName(n),
    title: title(n),
    channelName: channelName(n),
    pluralKebab: channelName(n),
    channelKind: flags.presence ? 'A presence channel: members see who else is on it' : 'A private channel',
    presenceType: flags.presence ? "  type: 'presence',\n" : '',
    // What other members see about someone: no secrets, every member gets it.
    presenceMember: flags.presence ? '  member: ({ user }) => ({ name: user.name }),\n' : '',
    ...(channelNames ? { Channel: channelNames.Name, channelKebab: channelNames.kebab, channelParam: channelNames.name } : {}),
    ...(eventNames ? { Event: eventNames.Name, eventKebab: eventNames.kebab } : {}),
    ...(jobNames ? { Job: jobNames.Name, jobKebab: jobNames.kebab } : {}),
  }
  if (options.dryRun) {
    const planned = files.map((file) => ({ path: file.path, contents: forProject(project, render(resolveStub(project, file.stub).template, values)), exists: existsSync(project.path(file.path)) }))
    return { schemaVersion: 1, kind, created: [], hints: hints(kind, n, flags), generate: 'skipped', planned }
  }
  for (const file of files) {
    const target = project.path(file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, forProject(project, render(resolveStub(project, file.stub).template, values)))
  }

  let generated: MakeResult['generate'] = 'skipped'
  if (existsSync(project.path(CONVENTIONS.env))) {
    try {
      await generate(project)
      generated = 'ok'
    } catch (error) {
      generated = { error: (error as Error).message }
    }
  }
  return { schemaVersion: 1, kind, created: files.map((f) => f.path), hints: hints(kind, n, flags), generate: generated }
}

/** Copies a built-in stub to `stubs/<name>.stub` so the app can customize it. */
export function ejectStub(project: Project, stub: string, options: { force?: boolean } = {}): { schemaVersion: 1; created: string[] } {
  if (!(stub in STUBS)) {
    throw new CalderaError('unknown_stub', `Unknown stub "${stub}". Stubs: ${Object.keys(STUBS).join(', ')}.`, { stubs: Object.keys(STUBS) })
  }
  const path = `stubs/${stub}.stub`
  if (existsSync(project.path(path)) && !options.force) {
    throw new CalderaError('file_exists', `Refusing to overwrite ${path}. Pass --force to replace.`, { files: [path] })
  }
  mkdirSync(project.path('stubs'), { recursive: true })
  writeFileSync(project.path(path), STUBS[stub as StubName])
  return { schemaVersion: 1, created: [path] }
}

/** Stubs import with `.js` (NodeNext); apps with bundler resolution (Next.js) import without an extension. */
function forProject(project: Project, contents: string): string {
  return project.importExtension === '' ? contents.replace(/(from\s+'\.{1,2}\/[^']+)\.js'/g, "$1'") : contents
}
