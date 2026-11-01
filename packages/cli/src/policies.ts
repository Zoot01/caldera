import { relative } from 'node:path'
import { CalderaError } from '@caldera-js/core'
import { exportsOfKind, policyFiles, routeFiles, type Project } from './project.js'
import { listRoutes } from './routes.js'

interface PolicyLike {
  model: { name: string }
  definition: Record<string, unknown>
}

interface AbilityLike {
  name: string
  guest: boolean
}

export interface PolicyExport {
  file: string
  exportName: string
  policy: PolicyLike
}

const RESERVED = new Set(['before', 'scope', 'prefetch'])
const NO_ROW = new Set(['viewAny', 'create'])

/** Every policy and standalone ability exported from `src/policies/*.ts`. */
export async function loadPolicies(project: Project): Promise<{ policies: PolicyExport[]; abilities: { file: string; ability: AbilityLike }[] }> {
  const policies: PolicyExport[] = []
  const abilities: { file: string; ability: AbilityLike }[] = []
  for (const file of policyFiles(project)) {
    const module = await project.load(file)
    for (const { exportName, value } of exportsOfKind<PolicyLike>(module, 'caldera.policy')) {
      const other = policies.find((p) => p.policy.model.name === value.model.name)
      if (other) throw new CalderaError('duplicate_policy', `Model "${value.model.name}" has policies in both ${other.file} and ${file}.`)
      policies.push({ file, exportName, policy: value })
    }
    for (const { value } of exportsOfKind<AbilityLike>(module, 'caldera.ability')) abilities.push({ file, ability: value })
  }
  return { policies, abilities }
}

/** `caldera abilities`: every ability, which models they guard and how. */
export async function describeAbilities(project: Project) {
  const { policies, abilities } = await loadPolicies(project)
  const rel = (file: string) => relative(project.root, project.path(file)).replaceAll('\\', '/')
  const routes = routeFiles(project).length > 0 ? (await listRoutes(project)).routes : []
  const guarding = (ability: string) => routes.filter((r) => typeof r.authorize === 'object' && r.authorize.ability === ability).map((r) => r.name)
  return {
    schemaVersion: 1 as const,
    policies: policies.map(({ file, policy }) => ({
      model: policy.model.name,
      file: rel(file),
      before: typeof policy.definition.before === 'function',
      scope: policy.definition.scope !== undefined,
      prefetch: typeof policy.definition.prefetch === 'function',
      abilities: Object.entries(policy.definition)
        .filter(([name]) => !RESERVED.has(name))
        .map(([name, entry]) => ({
          name: `${policy.model.name}.${name}`,
          ability: name,
          takesRow: !NO_ROW.has(name),
          guest: typeof entry === 'object' && entry !== null && (entry as { guest?: unknown }).guest === true,
          routes: guarding(`${policy.model.name}.${name}`),
        })),
    })),
    abilities: abilities.map(({ file, ability }) => ({ name: ability.name, guest: ability.guest, file: rel(file) })),
  }
}

