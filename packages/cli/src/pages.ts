import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONVENTIONS, exportsOfKind, type Project } from './project.js'

export interface PageFile {
  /** The component name handlers pass to `c.render`, e.g. `Posts/Index`. */
  name: string
  file: string
}

/** Every page under resources/pages, named by its path. Sorted, so generated output is stable. */
export function pageFiles(project: Project): PageFile[] {
  const root = project.path(CONVENTIONS.pagesDir)
  if (!existsSync(root)) return []
  const found: PageFile[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(relative, `${prefix}${entry.name}/`)
      else if (/\.(tsx|jsx)$/.test(entry.name) && !/\.(test|spec)\.[jt]sx$/.test(entry.name)) {
        found.push({ name: `${prefix}${entry.name.replace(/\.[jt]sx$/, '')}`, file: `${CONVENTIONS.pagesDir}/${relative}` })
      }
    }
  }
  walk('', '')
  return found
}

/** The `defineInertia()` export of src/inertia.ts, when the app has one. */
export async function loadInertia(project: Project): Promise<{ file: string; exportName: string } | undefined> {
  if (!existsSync(project.path(CONVENTIONS.inertia))) return undefined
  const [found] = exportsOfKind(await project.load(CONVENTIONS.inertia), 'caldera.inertia')
  return found ? { file: CONVENTIONS.inertia, exportName: found.exportName } : undefined
}

/**
 * The `@caldera/inertia` block of register.d.ts: each page's props come from its own component,
 * and the shared props from `defineInertia({ share })`, for the server (`c.render`) and the client
 * (Inertia's `InertiaConfig`, so `usePage().props.auth` is typed too).
 */
export async function inertiaRegister(project: Project, uses: (name: string) => boolean): Promise<string> {
  const pages = pageFiles(project)
  const inertia = await loadInertia(project)
  if (pages.length === 0 && !inertia) return ''
  const shared = inertia ? `SharedPropsOf<typeof import('${project.importFromGenerated(inertia.file)}').${inertia.exportName}>` : undefined
  const pageModule = (file: string) => project.importFromGenerated(file).replace(/\.[jt]sx$/, '.js')
  return (
    (pages.length ? `\nimport type { ComponentProps } from 'react'\n` : '\n') +
    (shared ? `import type { SharedPropsOf } from '@caldera/inertia'\n` : '') +
    `\ndeclare module '@caldera/inertia' {\n` +
    `  interface PageRegistry {\n` +
    pages.map((p) => `    '${p.name}': ComponentProps<typeof import('${pageModule(p.file)}').default>\n`).join('') +
    `  }\n` +
    (shared ? `  interface InertiaRegister {\n    shared: ${shared}\n  }\n` : '') +
    `}\n` +
    (shared && uses('@inertiajs/core')
      ? `\ndeclare module '@inertiajs/core' {\n  interface InertiaConfig {\n    sharedPageProps: ${shared}\n  }\n}\n`
      : '')
  )
}
