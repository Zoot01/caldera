import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { createJiti } from 'jiti'
import { CalderaError } from '@caldera/core'

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
  app: 'src/app.ts',
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
}

export function openProject(root: string = process.cwd()): Project {
  const absoluteRoot = resolve(root)
  // One module graph per project: app.ts, seeders and models must share the same table and model
  // instances, as in a real process. jiti's cache is Node's global CommonJS cache, so drop this
  // project's own files from it first; each openProject() (a command, a watch reload) starts fresh.
  purgeProjectModules(absoluteRoot)
  const jiti = createJiti(join(absoluteRoot, 'caldera.ts'), { moduleCache: true, fsCache: false })
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
      return (await jiti.import(file)) as never
    },
    async importPackage(specifier) {
      try {
        return (await jiti.import(specifier)) as never
      } catch {
        throw new CalderaError('missing_dependency', `${specifier} is not installed in this project.`, { package: specifier })
      }
    },
  }
}

/** TypeScript files directly inside a convention directory, sorted so generated output is stable. */
export function sourceFiles(project: Project, dir: string): string[] {
  const absolute = project.path(dir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts'))
    .sort()
    .map((file) => `${dir}/${file}`)
}

export const configFiles = (project: Project) => sourceFiles(project, CONVENTIONS.configDir)
export const routeFiles = (project: Project) => sourceFiles(project, CONVENTIONS.routesDir)
export const modelFiles = (project: Project) => sourceFiles(project, CONVENTIONS.modelsDir)
export const seederFiles = (project: Project) => sourceFiles(project, CONVENTIONS.seedersDir)
export const policyFiles = (project: Project) => sourceFiles(project, CONVENTIONS.policiesDir)

/** Finds exported values tagged with a Caldera `kind`, e.g. `caldera.config`. */
export function exportsOfKind<T>(module: Record<string, unknown>, kind: string): { exportName: string; value: T }[] {
  return Object.entries(module)
    .filter(([, value]) => typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === kind)
    .map(([exportName, value]) => ({ exportName, value: value as T }))
}

function purgeProjectModules(root: string) {
  const cache = createRequire(import.meta.url).cache
  const prefix = root.endsWith(sep) ? root : root + sep
  for (const file of Object.keys(cache)) {
    if (file.startsWith(prefix) && !file.includes(`${sep}node_modules${sep}`)) delete cache[file]
  }
}
