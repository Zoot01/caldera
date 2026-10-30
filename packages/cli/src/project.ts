import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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
  app: 'src/app.ts',
  generatedDir: '.caldera',
} as const

export interface Project {
  root: string
  path(relativePath: string): string
  /** Path from the generated directory to a project file, as an import specifier. */
  importFromGenerated(relativePath: string): string
  load<T = Record<string, unknown>>(relativePath: string): Promise<T>
}

export function openProject(root: string = process.cwd()): Project {
  const absoluteRoot = resolve(root)
  const jiti = createJiti(join(absoluteRoot, 'caldera.ts'), { moduleCache: false, fsCache: false })
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

/** Finds exported values tagged with a Caldera `kind`, e.g. `caldera.config`. */
export function exportsOfKind<T>(module: Record<string, unknown>, kind: string): { exportName: string; value: T }[] {
  return Object.entries(module)
    .filter(([, value]) => typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === kind)
    .map(([exportName, value]) => ({ exportName, value: value as T }))
}
