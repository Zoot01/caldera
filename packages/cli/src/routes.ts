import { relative } from 'node:path'
import { CalderaError } from '@caldera-js/core'
import { exportsOfKind, routeFiles, type Project } from './project.js'

// Structural copy of @caldera-js/http's RouteRecord, so the CLI doesn't need it installed.
export interface RouteRecord {
  name: string
  method: string
  path: string
  params: string[]
  middleware: { name: string; options: unknown }[]
  input: Record<string, unknown>
  bindings?: Record<string, string>
  authorize?: { ability: string; param: string | null } | 'custom'
  description?: string
  source?: { file: string; line: number }
}

interface RouteGroupLike {
  name: string
  routes: readonly RouteRecord[]
}

export interface RouteGroupExport {
  file: string
  exportName: string
  group: RouteGroupLike
}

/** Imports every file in `src/routes` and returns the route groups it exports. */
export async function loadRouteGroups(project: Project): Promise<RouteGroupExport[]> {
  const found: RouteGroupExport[] = []
  for (const file of routeFiles(project)) {
    const module = await project.load(file)
    for (const { exportName, value } of exportsOfKind<RouteGroupLike>(module, 'caldera.routes')) {
      found.push({ file, exportName, group: value })
    }
  }
  const owner = new Map<string, string>()
  for (const { file, group } of found) {
    for (const route of group.routes) {
      const other = owner.get(route.name)
      if (other) throw new CalderaError('duplicate_route', `Route "${route.name}" is defined in both ${other} and ${file}.`)
      owner.set(route.name, file)
    }
  }
  return found
}

/** The route manifest behind `caldera route:list`, with source paths relative to the project. */
export async function listRoutes(project: Project): Promise<{ schemaVersion: 1; routes: RouteRecord[] }> {
  const groups = await loadRouteGroups(project)
  const routes = groups.flatMap(({ group }) =>
    group.routes.map((route) =>
      route.source ? { ...route, source: { ...route.source, file: relative(project.root, route.source.file).replaceAll('\\', '/') } } : route,
    ),
  )
  return { schemaVersion: 1, routes }
}
