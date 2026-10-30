import { existsSync } from 'node:fs'
import { CalderaError } from '@caldera/core'
import { CONVENTIONS, exportsOfKind, modelFiles, type Project } from './project.js'

interface RelationsEntry {
  table: object
  relations: Record<string, { relationType: 'one' | 'many'; targetTableName: string }>
}

interface ModelLike {
  name: string
  table: object
  describe?: () => unknown
}

export interface ModelExport {
  file: string
  exportName: string
  /** The model's key in the Drizzle relations, e.g. `posts`. */
  key: string
  model: ModelLike
}

export interface LoadedModels {
  relations: Record<string, RelationsEntry> | undefined
  models: ModelExport[]
}

/** Loads `src/db/relations.ts` and every model in `src/models`, matching each model to its relations key. */
export async function loadModels(project: Project): Promise<LoadedModels> {
  if (!existsSync(project.path(CONVENTIONS.relations))) {
    if (modelFiles(project).length > 0) {
      throw new CalderaError('missing_file', `Models need ${CONVENTIONS.relations} exporting \`relations\` from defineRelations().`, {
        file: CONVENTIONS.relations,
      })
    }
    return { relations: undefined, models: [] }
  }
  const relations = (await project.load(CONVENTIONS.relations)).relations as Record<string, RelationsEntry> | undefined
  if (!relations || typeof relations !== 'object') {
    throw new CalderaError('relations_definition', `${CONVENTIONS.relations} must export \`relations\` (the result of defineRelations).`)
  }
  // Matched by schema-qualified SQL name, not identity: each file is loaded with a fresh module
  // cache, so relations.ts and a model file hold different instances of the same table.
  const keyByTable = new Map(Object.entries(relations).map(([key, entry]) => [tableId(entry.table), key]))

  const models: ModelExport[] = []
  const byName = new Map<string, string>()
  for (const file of modelFiles(project)) {
    const module = await project.load(file)
    for (const { exportName, value } of exportsOfKind<ModelLike>(module, 'caldera.model')) {
      const key = keyByTable.get(tableId(value.table))
      if (!key) {
        throw new CalderaError('model_definition', `Model "${value.name}" in ${file} uses a table that isn't in ${CONVENTIONS.relations}.`)
      }
      const other = byName.get(value.name)
      if (other) throw new CalderaError('duplicate_model', `Model "${value.name}" is defined in both ${other} and ${file}.`)
      byName.set(value.name, file)
      models.push({ file, exportName, key, model: value })
    }
  }
  return { relations, models }
}

// Drizzle stores these under global symbols, so reading them doesn't require importing drizzle-orm.
const TABLE_NAME = Symbol.for('drizzle:Name')
const TABLE_SCHEMA = Symbol.for('drizzle:Schema')

function tableId(table: object): string {
  const t = table as Record<symbol, string | undefined>
  return `${t[TABLE_SCHEMA] ?? ''}.${t[TABLE_NAME] ?? ''}`
}
