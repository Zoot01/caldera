import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CalderaError } from '@caldera/core'
import { generate } from './codegen.js'
import { names, render, type Names } from './names.js'
import { CONVENTIONS, type Project } from './project.js'
import { STUBS, type StubName } from './stubs.js'

export const MAKE_KINDS = ['model', 'policy', 'factory', 'seeder', 'routes', 'config', 'provider', 'page', 'job', 'event', 'listener', 'schedule'] as const
export type MakeKind = (typeof MAKE_KINDS)[number]

interface Planned {
  path: string
  stub: StubName
}

/** Where each kind of file goes. These paths are the conventions codegen and agents rely on. */
function plan(kind: MakeKind, n: Names & { page: string }, project: Project, options: { table: boolean }): Planned[] {
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
      return [{ path: `${CONVENTIONS.routesDir}/${n.kebab}.ts`, stub: 'routes' }]
    case 'config':
      return [{ path: `${CONVENTIONS.configDir}/${n.kebab}.ts`, stub: 'config' }]
    case 'provider':
      return [{ path: `src/providers/${n.kebab}.ts`, stub: 'provider' }]
    case 'page':
      return [{ path: `${CONVENTIONS.pagesDir}/${n.page}.tsx`, stub: 'page' }]
    case 'job':
      return [{ path: `${CONVENTIONS.jobsDir}/${n.kebab}.ts`, stub: 'job' }]
    case 'event':
      return [{ path: `${CONVENTIONS.eventsDir}/${n.kebab}.ts`, stub: 'event' }]
    case 'listener':
      return [{ path: `${CONVENTIONS.listenersDir}/${n.kebab}.ts`, stub: 'listener' }]
    case 'schedule':
      return [{ path: `${CONVENTIONS.schedulesDir}/${n.kebab}.ts`, stub: 'schedule' }]
  }
}

/** Next steps generators print instead of editing files you own. */
function hints(kind: MakeKind, n: Names & { page: string }, options: { table: boolean }): string[] {
  if (kind === 'model' && options.table) {
    return [`Add \`${n.plural}\` (from src/db/tables/${n.kebab}.ts) to defineRelations in ${CONVENTIONS.relations}, then run \`caldera db:generate\`.`]
  }
  if (kind === 'model' && !options.table) return [`Point the import in ${CONVENTIONS.modelsDir}/${n.kebab}.ts at your existing \`${n.plural}\` table.`]
  if (kind === 'provider') return [`Add \`${n.name}Provider\` to the providers in ${CONVENTIONS.app}.`]
  if (kind === 'schedule') return [`\`caldera schedule:list\` shows its next run; \`caldera schedule:work\` (or a platform cron, see \`caldera schedule:sync\`) runs it.`]
  if (kind === 'event') return [`Emit it with \`await emit(${n.Name}, { id })\` from '@caldera/events'; add listeners with \`caldera make:listener <Name> --event ${n.Name}\`.`]
  if (kind === 'listener') return [`It runs on every emit of its event. For slow work, listen with a job instead: \`listen(Event, Job.fromEvent((e) => ({ ... })))\`.`]
  if (kind === 'job') return [`Dispatch it with \`await dispatch(${n.Name}, { id })\` from '@caldera/queue'; \`caldera queue:work\` runs it.`]
  if (kind === 'page') return [`Render it from a route: \`c.render('${n.page}', { title: '${n.Name}' })\`.`]
  return []
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
}

export async function make(
  project: Project,
  kind: MakeKind,
  rawName: string,
  options: { force?: boolean; table?: boolean; event?: string; job?: string } = {},
): Promise<MakeResult> {
  let n: Names & { page: string }
  try {
    // Pages are paths (`Posts/Index`): each segment is a PascalCase folder or file name.
    const segments = kind === 'page' ? rawName.split('/').filter(Boolean).map((segment) => names(segment).Name) : []
    n = { ...names(kind === 'page' ? (segments.at(-1) ?? '') : rawName), page: segments.join('/') }
  } catch (error) {
    throw new CalderaError('invalid_name', (error as Error).message)
  }
  const table = options.table ?? true
  const files = plan(kind, n, project, { table })
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
  const values = {
    ...n,
    ...(eventNames ? { Event: eventNames.Name, eventKebab: eventNames.kebab } : {}),
    ...(jobNames ? { Job: jobNames.Name, jobKebab: jobNames.kebab } : {}),
  }
  for (const file of files) {
    const target = project.path(file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, render(resolveStub(project, file.stub).template, values))
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
  return { schemaVersion: 1, kind, created: files.map((f) => f.path), hints: hints(kind, n, { table }), generate: generated }
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
