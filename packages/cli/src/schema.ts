import { CalderaError } from '@caldera/core'
import { relative } from 'node:path'
import { loadModels } from './models.js'
import { names } from './names.js'
import type { Project } from './project.js'

// Drizzle keeps table metadata under global symbols, so the CLI can read any app's tables
// without importing (or version-matching) drizzle-orm itself.
const TABLE_NAME = Symbol.for('drizzle:Name')
const TABLE_SCHEMA = Symbol.for('drizzle:Schema')
const TABLE_COLUMNS = Symbol.for('drizzle:Columns')

interface ColumnLike {
  name: string
  notNull: boolean
  primary: boolean
  hasDefault: boolean
  getSQLType?: () => string
}

export interface ColumnDescription {
  name: string
  column: string
  type: string
  nullable: boolean
  primary: boolean
  hasDefault: boolean
}

export interface TableDescription {
  key: string
  table: string
  schema: string | null
  model: string | null
  columns: ColumnDescription[]
  relations: { name: string; type: 'one' | 'many'; target: string }[]
}

export function describeTable(table: object): Pick<TableDescription, 'table' | 'schema' | 'columns'> {
  const t = table as Record<symbol, unknown>
  const columns = (t[TABLE_COLUMNS] ?? {}) as Record<string, ColumnLike>
  return {
    table: String(t[TABLE_NAME]),
    schema: (t[TABLE_SCHEMA] as string | undefined) ?? null,
    columns: Object.entries(columns).map(([name, column]) => ({
      name,
      column: column.name,
      type: column.getSQLType?.() ?? 'unknown',
      nullable: !column.notNull,
      primary: column.primary,
      hasDefault: column.hasDefault,
    })),
  }
}

/** Every table in `src/db/relations.ts`: columns, relations and which model (if any) wraps it. */
export async function describeSchema(project: Project): Promise<{ schemaVersion: 1; tables: TableDescription[] }> {
  const { relations, models } = await loadModels(project)
  if (!relations) return { schemaVersion: 1, tables: [] }
  const modelByKey = new Map(models.map((m) => [m.key, m.model.name]))
  const tables = Object.entries(relations).map(([key, entry]) => ({
    key,
    ...describeTable(entry.table),
    model: modelByKey.get(key) ?? null,
    relations: Object.entries(entry.relations).map(([name, relation]) => ({ name, type: relation.relationType, target: relation.targetTableName })),
  }))
  return { schemaVersion: 1, tables }
}

/** One model's definition plus its table, relations and source file, for `caldera model:show`. */
export async function describeModel(project: Project, nameOrKey: string) {
  const { relations, models } = await loadModels(project)
  // `Note`, `note` and `notes` all find it: make:model takes the class-style name.
  const wanted = names(nameOrKey).name
  const found = models.find((m) => m.model.name === nameOrKey || m.key === nameOrKey || m.model.name === wanted)
  if (!found || !relations) {
    throw new CalderaError('unknown_model', `No model named "${nameOrKey}". Known models: ${models.map((m) => m.model.name).join(', ') || 'none'}.`, {
      known: models.map((m) => m.model.name),
    })
  }
  const definition = { ...(found.model.describe?.() as { hidden?: string[]; guarded?: string[] } | undefined), name: found.model.name }
  const table = describeTable(relations[found.key]!.table)
  return {
    schemaVersion: 1 as const,
    ...definition,
    key: found.key,
    file: relative(project.root, project.path(found.file)).replaceAll('\\', '/'),
    table: table.table,
    columns: table.columns.map((c) => ({ ...c, hidden: definition.hidden?.includes(c.name) ?? false, guarded: definition.guarded?.includes(c.name) ?? false })),
    relations: Object.entries(relations[found.key]!.relations).map(([name, relation]) => ({
      name,
      type: relation.relationType,
      target: relation.targetTableName,
      model: models.find((m) => m.key === relation.targetTableName)?.model.name ?? null,
    })),
  }
}
