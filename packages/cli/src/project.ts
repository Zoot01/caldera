import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CalderaError } from '@caldera/core'
import { register } from 'tsx/esm/api'

/**
 * File conventions every Caldera app follows. Generators, codegen and agents all
 * rely on these paths, so they are deliberately not configurable yet.
 */
export const CONVENTIONS = {
  env: 'src/env.ts',
  configDir: 'src/config',
  routesDir: 'src/routes',
  relations: 'src/db/relations.ts',
  modelsDir: 'src/models',
  seedersDir: 'src/db/seeders',
  policiesDir: 'src/policies',
  jobsDir: 'src/jobs',
  eventsDir: 'src/events',
  listenersDir: 'src/listeners',
  schedulesDir: 'src/schedules',
  mailDir: 'src/mail',
  notificationsDir: 'src/notifications',
  app: 'src/app.ts',
  inertia: 'src/inertia.ts',
  pagesDir: 'resources/pages',
  generatedDir: '.caldera',
} as const

export interface Project {
  root: string
  path(relativePath: string): string
  /** Path from the generated directory to a project file, as an import specifier. */
  importFromGenerated(relativePath: string): string
  load<T = Record<string, unknown>>(relativePath: string): Promise<T>
  /** Imports a package as the project resolves it, e.g. its own `better-auth`. */
  importPackage<T = Record<string, unknown>>(specifier: string): Promise<T>
  /** Removes this project's loader hooks. Long-running commands (dev) call it before reloading. */
  dispose(): Promise<void>
}

let loaders = 0

export function openProject(root: string = process.cwd()): Project {
  const absoluteRoot = resolve(root)
  // One module graph per project: app.ts, seeders and models must share the same table and model
  // instances, as in a real process. tsx's loader gives each openProject() (a command, a watch
  // reload) its own namespace, so every load starts fresh and sees edits. It loads code the way the
  // app runs it: `.js` imports of `.ts`/`.tsx` files, JSX in mail templates, tsconfig paths.
  const loader = register({ namespace: `caldera-${process.pid}-${++loaders}` })
  // Stack traces in source positions (tsx writes inline source maps): routes and limiters record
  // where they're defined from them, for route:list and AGENTS.md.
  process.setSourceMapsEnabled(true)
  const parent = pathToFileURL(join(absoluteRoot, 'caldera.ts')).href
  const path = (relativePath: string) => join(absoluteRoot, relativePath)

  return {
    root: absoluteRoot,
    path,
    importFromGenerated(relativePath) {
      const specifier = relative(path(CONVENTIONS.generatedDir), path(relativePath)).replaceAll('\\', '/')
      return specifier.replace(/\.ts$/, '.js')
    },
    async load(relativePath) {
      const file = path(relativePath)
      if (!existsSync(file)) {
        throw new CalderaError('missing_file', `Expected ${relativePath} in ${absoluteRoot}.`, { file: relativePath })
      }
      return (await loader.import(pathToFileURL(file).href, parent)) as never
    },
    async importPackage(specifier) {
      try {
        return (await loader.import(specifier, parent)) as never
      } catch {
        throw new CalderaError('missing_dependency', `${specifier} is not installed in this project.`, { package: specifier })
      }
    },
    async dispose() {
      await loader.unregister()
    },
  }
}

/** TypeScript files directly inside a convention directory, sorted so generated output is stable. */
export function sourceFiles(project: Project, dir: string, options: { tsx?: boolean } = {}): string[] {
  const absolute = project.path(dir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute)
    .filter((file) => (file.endsWith('.ts') || (options.tsx && file.endsWith('.tsx'))) && !file.endsWith('.d.ts') && !/\.test\.tsx?$/.test(file))
    .sort()
    .map((file) => `${dir}/${file}`)
}

export const configFiles = (project: Project) => sourceFiles(project, CONVENTIONS.configDir)
export const routeFiles = (project: Project) => sourceFiles(project, CONVENTIONS.routesDir)
export const modelFiles = (project: Project) => sourceFiles(project, CONVENTIONS.modelsDir)
export const seederFiles = (project: Project) => sourceFiles(project, CONVENTIONS.seedersDir)
export const policyFiles = (project: Project) => sourceFiles(project, CONVENTIONS.policiesDir)
export const jobFiles = (project: Project) => sourceFiles(project, CONVENTIONS.jobsDir)
export const listenerFiles = (project: Project) => sourceFiles(project, CONVENTIONS.listenersDir)
export const scheduleFiles = (project: Project) => sourceFiles(project, CONVENTIONS.schedulesDir)
export const mailFiles = (project: Project) => sourceFiles(project, CONVENTIONS.mailDir, { tsx: true })
export const notificationFiles = (project: Project) => sourceFiles(project, CONVENTIONS.notificationsDir)

/** Finds exported values tagged with a Caldera `kind`, e.g. `caldera.config`. */
export function exportsOfKind<T>(module: Record<string, unknown>, kind: string): { exportName: string; value: T }[] {
  return Object.entries(module)
    .filter(([, value]) => typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === kind)
    .map(([exportName, value]) => ({ exportName, value: value as T }))
}

