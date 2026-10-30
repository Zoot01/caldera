import { CalderaError, CapabilityError } from '@caldera/core'
import {
  eq,
  getColumns,
  sql,
  type DBQueryConfigRoot,
  type RelationsFilter,
  type Simplify,
  type Table,
  type TablesRelationalConfig,
} from 'drizzle-orm'
import { defaultDatabase, type Database } from '../database.js'
import type { AppendsOf, InsertRaw, KeyOfTable, OmitKeys, RelationsOf, S, Select, TableKey, TargetOf } from './registry.js'
import type { ModelResult } from './result.js'

type ManyConfig<K extends TableKey> = DBQueryConfigRoot<'many', S, S[K]>
type OneConfig<K extends TableKey> = DBQueryConfigRoot<'one', S, S[K]>
export type Filter<K extends TableKey> = RelationsFilter<S[K], S>

export interface Page<T> {
  data: T[]
  total: number
  page: number
  perPage: number
  lastPage: number
}

/** Reads. Every method applies the model's defaults: hidden columns excluded, soft-deleted rows filtered. */
export interface QueryApi<K extends TableKey> {
  findMany<C extends ManyConfig<K>>(config?: ManyConfig<K> extends C ? C : ManyConfig<K>): Promise<ModelResult<K, C>[]>
  findFirst<C extends OneConfig<K>>(config?: OneConfig<K> extends C ? C : OneConfig<K>): Promise<ModelResult<K, C> | undefined>
  find(id: string | number): Promise<ModelResult<K, true> | undefined>
  /** Throws `ModelNotFoundError`, which `@caldera/http` renders as a 404. */
  findOrFail(id: string | number): Promise<ModelResult<K, true>>
  /** Looks up by the model's `routeKey` (or primary key). Used by route model binding. */
  findByRouteKey(value: string | number): Promise<ModelResult<K, true> | undefined>
  paginate<C extends ManyConfig<K>>(
    config: (ManyConfig<K> extends C ? C : ManyConfig<K>) & { page?: number; perPage?: number },
  ): Promise<Page<ModelResult<K, C>>>
}

export type RowOf<K extends TableKey, H> = OmitKeys<Select<K>, H>
export type InsertOf<K extends TableKey, G> = OmitKeys<InsertRaw<K>, G>
type Patch<K extends TableKey, G> = Partial<InsertOf<K, G>>

type SerializeOne<K extends TableKey, R> = R extends null | undefined
  ? R
  : Simplify<{ [P in keyof R]: P extends keyof RelationsOf<K> ? SerializeOut<TargetOf<K, P>, R[P]> : R[P] } & AppendsOf<K>>
export type SerializeOut<K extends TableKey, R> = R extends readonly (infer E)[] ? SerializeOne<K, E>[] : SerializeOne<K, R>

/**
 * "-ing" hooks run before the write (inside any open transaction) and may reshape values or throw.
 * "-ed" hooks run after the transaction commits, so a job they dispatch never sees uncommitted data.
 */
export interface Hooks<K extends TableKey, H, G> {
  creating?: (values: InsertOf<K, G>) => InsertOf<K, G> | Promise<InsertOf<K, G>>
  created?: (row: RowOf<K, H>) => unknown
  updating?: (args: { before: RowOf<K, H>; patch: Patch<K, G> }) => Patch<K, G> | Promise<Patch<K, G>>
  updated?: (args: { before: RowOf<K, H>; patch: Patch<K, G>; after: RowOf<K, H> }) => unknown
  deleting?: (row: RowOf<K, H>) => unknown
  /** `soft`: the row was only soft-deleted (it can be restored), not removed. */
  deleted?: (row: RowOf<K, H>, info: { soft: boolean }) => unknown
}

type RowRef = string | number | Record<string, unknown>

export type Model<K extends TableKey, Name extends string, H extends string, G extends string, A, Sc, SD extends string = never> = QueryApi<K> & {
  readonly kind: 'caldera.model'
  readonly name: Name
  readonly table: S[K]['table']
  readonly '~key': K
  readonly '~hidden': H
  readonly '~guarded': G
  readonly '~appends': A
  readonly '~softDeletes': SD
  /** Includes soft-deleted rows. */
  withTrashed(): QueryApi<K>
  /** Only soft-deleted rows. */
  onlyTrashed(): QueryApi<K>
  /** Includes hidden columns, e.g. to check a password hash. Never send the result to a client. */
  withHidden(): QueryApi<K>
  create(input: InsertOf<K, G>): Promise<RowOf<K, H>>
  createMany(inputs: InsertOf<K, G>[]): Promise<RowOf<K, H>[]>
  /** Like `create` but may set guarded columns. For trusted internal code only. */
  forceCreate(input: InsertRaw<K>): Promise<RowOf<K, H>>
  /** Pass the row you already have (e.g. from route binding) so hooks get `before` without another query. */
  update(row: RowRef, patch: Patch<K, G>): Promise<RowOf<K, H>>
  /** Soft-deletes when the model has `softDeletes`, otherwise deletes. */
  delete(row: RowRef): Promise<void>
  restore(row: RowRef): Promise<RowOf<K, H>>
  forceDelete(row: RowRef): Promise<void>
  /** Adds `appends` (recursively through loaded relations). Call it at the response boundary. */
  serialize<R extends object | null | undefined>(rows: R): SerializeOut<K, R>
  /** The model's definition as JSON, for `caldera model:show` and agents. */
  describe(): ModelDescription
  /** The same model bound to a specific database instead of the default one. */
  using(database: Database<any>): Model<K, Name, H, G, A, Sc, SD>
} & { [N in keyof Sc]: Sc[N] extends (...args: infer P) => any ? (...args: P) => QueryApi<K> : never }

export interface ModelDescription {
  name: string
  primaryKey: string
  routeKey: string
  hidden: readonly string[]
  guarded: readonly string[]
  softDeletes: string | null
  scopes: string[]
  appends: string[]
  hooks: string[]
}

export type AnyModel = {
  readonly kind: 'caldera.model'
  readonly name: string
  readonly table: Table
  readonly '~key': TableKey
  readonly '~hidden': string
  readonly '~guarded': string
  readonly '~appends': unknown
}

export type Row<M extends AnyModel> = RowOf<M['~key'], M['~hidden']>
export type Insert<M extends AnyModel> = InsertOf<M['~key'], M['~guarded']>
export type Serialized<M extends AnyModel> = Simplify<Row<M> & M['~appends']>

type SelOf<T> = T extends { $inferSelect: infer X } ? X : never
type InsOf<T> = T extends { $inferInsert: infer X } ? X : never

export interface ModelConfig<T extends Table, Name extends string, H, G, A, Sc, SD, K extends TableKey> {
  name: Name
  hidden?: readonly H[]
  guarded?: readonly G[]
  softDeletes?: SD
  routeKey?: keyof SelOf<T> & string
  // The intersection gives scopes a contextual return type, so `{ isNull: true }` isn't widened.
  scopes?: Sc & Record<keyof Sc, (...args: any[]) => Filter<K>>
  appends?: { [P in keyof A]: (row: OmitKeys<SelOf<T>, H>) => A[P] }
  hooks?: Hooks<K, H, G>
}

export class ModelNotFoundError extends CalderaError {
  constructor(model: string, id: unknown) {
    super('not_found', `No ${model} found for ${JSON.stringify(id)}.`, { model, id })
  }
}

// Runtime registry: relations key → model definition, for nested defaults and serialization.
const modelsByTable = new Map<Table, RuntimeModel>()

interface RuntimeModel {
  name: string
  table: Table
  hidden: readonly string[]
  guarded: readonly string[]
  softDeletes: string | undefined
  appends: Record<string, (row: never) => unknown>
}

// The public Hooks type is checked at the call site; inside the runtime rows are plain records.
type AnyRecord = Record<string, unknown>
interface LooseHooks {
  creating?: (values: AnyRecord) => AnyRecord | Promise<AnyRecord>
  created?: (row: AnyRecord) => unknown
  updating?: (args: { before: AnyRecord; patch: AnyRecord }) => AnyRecord | Promise<AnyRecord>
  updated?: (args: { before: AnyRecord; patch: AnyRecord; after: AnyRecord }) => unknown
  deleting?: (row: AnyRecord) => unknown
  deleted?: (row: AnyRecord, info: { soft: boolean }) => unknown
}

type Trashed = 'exclude' | 'include' | 'only'
interface QueryState {
  database: Database<any> | undefined
  trashed: Trashed
  withHidden: boolean
  where: unknown[]
}

/**
 * A thin data-mapper over a Drizzle table: rows stay plain objects. Adds what Drizzle lacks
 * (hidden and guarded columns, soft deletes, scopes, hooks, appends) and nothing else.
 * Use `Model.table` for raw Drizzle, which bypasses all of it.
 */
export function defineModel<
  T extends Table,
  const Name extends string,
  const H extends keyof SelOf<T> & string = never,
  const G extends keyof InsOf<T> & string = never,
  A = {},
  Sc extends Record<string, (...args: any[]) => unknown> = {},
  const SD extends keyof SelOf<T> & string = never,
  // Resolved once as a defaulted type parameter: writing KeyOfTable<T> inline cost ~3x instantiations.
  K extends TableKey = KeyOfTable<T>,
>(table: T, config: ModelConfig<T, Name, H, G, A, Sc, SD, K>): Model<K, Name, H, G, A, Sc, SD> {
  const columns = getColumns(table) as Record<string, { primary: boolean }>
  const foundKey = Object.keys(columns).find((key) => columns[key]!.primary)
  if (!foundKey) throw new CalderaError('model_definition', `Model "${config.name}" needs a table with a single-column primary key.`)
  const primaryKey: string = foundKey
  const routeKey = config.routeKey ?? primaryKey

  const runtime: RuntimeModel = {
    name: config.name,
    table,
    hidden: (config.hidden ?? []) as readonly string[],
    guarded: (config.guarded ?? []) as readonly string[],
    softDeletes: config.softDeletes as string | undefined,
    appends: (config.appends ?? {}) as RuntimeModel['appends'],
  }
  modelsByTable.set(table, runtime)
  const hooks = (config.hooks ?? {}) as LooseHooks
  const sdColumn = runtime.softDeletes ? (table as any)[runtime.softDeletes] : undefined

  function build(state: QueryState): any {
    const database = () => state.database ?? defaultDatabase()
    const client = () => database().current() as any
    const relational = () => {
      const c = client()
      const relations = c._?.relations as TablesRelationalConfig | undefined
      if (!relations) throw new CalderaError('model_definition', 'Models need a Drizzle client created with `relations`.')
      const key = keyForTable(relations, table)
      return { builder: c.query[key], relations, key }
    }

    const shape = (input: any, root: boolean) => {
      const { relations, key } = relational()
      const where = [...(root ? state.where : []), ...(input?.where ? [input.where] : [])]
      const shaped = applyDefaults(runtime, { ...input, where: undefined }, relations, key, root ? state.trashed : 'exclude', state.withHidden)
      const allWhere = [...where, ...(shaped.where ? [shaped.where] : [])]
      const final = { ...shaped, where: allWhere.length === 0 ? undefined : allWhere.length === 1 ? allWhere[0] : { AND: allWhere } }
      if (final.where === undefined) delete final.where
      return final
    }

    const api: Record<string, unknown> = {
      findMany: (input?: any) => relational().builder.findMany(shape(input, true)),
      findFirst: (input?: any) => relational().builder.findFirst(shape(input, true)),
      find: (id: unknown) => relational().builder.findFirst(shape({ where: { [primaryKey]: id } }, true)),
      findByRouteKey: (value: unknown) => relational().builder.findFirst(shape({ where: { [routeKey]: value } }, true)),
      async findOrFail(id: unknown) {
        const row = await (api.find as (id: unknown) => Promise<unknown>)(id)
        if (!row) throw new ModelNotFoundError(config.name, id)
        return row
      },
      async paginate(input: any) {
        const { page: rawPage = 1, perPage: rawPerPage = 15, ...rest } = input ?? {}
        const page = Math.max(1, Math.floor(rawPage))
        const perPage = Math.min(Math.max(1, Math.floor(rawPerPage)), 500)
        const shaped = shape(rest, true)
        const { builder } = relational()
        // Counted through the relational builder so every filter shape Drizzle accepts (including
        // filters on related rows) works. Its exported relationsFilterToSQL mishandles AND/OR.
        const countRows = (): Promise<number> =>
          builder
            .findFirst({ ...(shaped.where ? { where: shaped.where } : {}), columns: {}, extras: { total: sql<number>`count(*)`.mapWith(Number) } })
            .then((row: { total?: number } | undefined) => row?.total ?? 0)
        const [data, total] = await Promise.all([builder.findMany({ ...shaped, limit: perPage, offset: (page - 1) * perPage }), countRows()])
        return { data, total: Number(total), page, perPage, lastPage: Math.max(1, Math.ceil(Number(total) / perPage)) }
      },
    }

    const visible = (row: Record<string, unknown>) => (state.withHidden ? row : omit(row, runtime.hidden))
    const requireReturning = () => {
      const db = database()
      if (!db.capabilities.returning) throw new CapabilityError(db.driver, 'INSERT … RETURNING', 'Models need it to return written rows.')
    }
    const resolve = async (ref: RowRef, trashed: Trashed = 'exclude') => {
      // A row object is re-read by its key: hooks get the stored row as `before`, not a caller's
      // possibly stale copy (file cleanup would delete the wrong object). A row the caller holds may
      // be soft-deleted, so it's found either way.
      const id = typeof ref === 'object' ? ref[primaryKey] : ref
      if (id === undefined || id === null) throw new CalderaError('model_row_key', `A ${config.name} row was passed without its "${primaryKey}".`)
      const row = await build({ ...state, trashed: typeof ref === 'object' && trashed === 'exclude' ? 'include' : trashed, withHidden: true }).find(id as string | number)
      if (!row) throw new ModelNotFoundError(config.name, id)
      return visible(row as Record<string, unknown>)
    }
    const afterCommit = (fn: () => unknown) => database().afterCommit(fn)

    const insert = async (values: Record<string, unknown>) => {
      requireReturning()
      const prepared = hooks.creating ? await hooks.creating(values) : values
      const [row] = await client().insert(table).values(prepared).returning()
      const result = visible(row)
      if (hooks.created) await afterCommit(() => hooks.created!(result))
      return result
    }

    const write = {
      create: (input: Record<string, unknown>) => insert(omit(input, runtime.guarded)),
      forceCreate: (input: Record<string, unknown>) => insert(input),
      async createMany(inputs: Record<string, unknown>[]) {
        const rows = []
        for (const input of inputs) rows.push(await insert(omit(input, runtime.guarded)))
        return rows
      },
      async update(ref: RowRef, patch: Record<string, unknown>) {
        requireReturning()
        const before = await resolve(ref)
        const id = before[primaryKey]
        const cleaned = omit(patch, runtime.guarded)
        const prepared = hooks.updating ? await hooks.updating({ before, patch: cleaned }) : cleaned
        const [row] = await client()
          .update(table)
          .set(prepared)
          .where(eq((table as any)[primaryKey], id))
          .returning()
        if (!row) throw new ModelNotFoundError(config.name, id)
        const after = visible(row)
        if (hooks.updated) await afterCommit(() => hooks.updated!({ before, patch: prepared, after }))
        return after
      },
      async delete(ref: RowRef) {
        const row = await resolve(ref)
        if (hooks.deleting) await hooks.deleting(row)
        const id = row[primaryKey]
        if (sdColumn) await client().update(table).set({ [runtime.softDeletes!]: new Date() }).where(eq((table as any)[primaryKey], id))
        else await client().delete(table).where(eq((table as any)[primaryKey], id))
        if (hooks.deleted) await afterCommit(() => hooks.deleted!(row, { soft: Boolean(sdColumn) }))
      },
      async forceDelete(ref: RowRef) {
        const row = await resolve(ref, 'include')
        if (hooks.deleting) await hooks.deleting(row)
        await client().delete(table).where(eq((table as any)[primaryKey], row[primaryKey]))
        if (hooks.deleted) await afterCommit(() => hooks.deleted!(row, { soft: false }))
      },
      async restore(ref: RowRef) {
        if (!sdColumn) throw new CalderaError('model_definition', `Model "${config.name}" doesn't use softDeletes.`)
        requireReturning()
        const row = await resolve(ref, 'only')
        const [restored] = await client()
          .update(table)
          .set({ [runtime.softDeletes!]: null })
          .where(eq((table as any)[primaryKey], row[primaryKey]))
          .returning()
        return visible(restored)
      },
    }

    const model: Record<string, unknown> = {
      ...api,
      ...write,
      kind: 'caldera.model',
      name: config.name,
      table,
      withTrashed: () => build({ ...state, trashed: 'include' }),
      onlyTrashed: () => build({ ...state, trashed: 'only' }),
      withHidden: () => build({ ...state, withHidden: true }),
      using: (db: Database<any>) => build({ ...state, database: db }),
      serialize: (rows: unknown) => serialize(runtime, rows, () => relational().relations, table),
      describe: () => ({
        name: config.name,
        primaryKey,
        routeKey,
        hidden: runtime.hidden,
        guarded: runtime.guarded,
        softDeletes: runtime.softDeletes ?? null,
        scopes: Object.keys(config.scopes ?? {}),
        appends: Object.keys(runtime.appends),
        hooks: Object.keys(hooks).filter((name) => typeof (hooks as Record<string, unknown>)[name] === 'function'),
      }),
    }
    for (const [scopeName, scope] of Object.entries(config.scopes ?? {})) {
      model[scopeName] = (...args: unknown[]) => build({ ...state, where: [...state.where, (scope as Function)(...args)] })
    }
    return model
  }

  return build({ database: undefined, trashed: 'exclude', withHidden: false, where: [] })
}

const keyCache = new WeakMap<TablesRelationalConfig, Map<Table, string>>()

function keyForTable(relations: TablesRelationalConfig, table: Table): string {
  let byTable = keyCache.get(relations)
  if (!byTable) {
    byTable = new Map(Object.entries(relations).map(([key, entry]) => [entry.table as Table, key]))
    keyCache.set(relations, byTable)
  }
  const key = byTable.get(table)
  if (!key) throw new CalderaError('model_definition', 'This table is missing from the relations passed to drizzle().')
  return key
}

/**
 * Adds model defaults to a relational query config, recursively through `with`.
 * Soft deletes filter the root and nested `many` relations, but not `one` relations: filtering
 * a `one` relation would make it nullable everywhere (DESIGN 3b, decided 2026-10-30).
 */
function applyDefaults(model: RuntimeModel, input: any, relations: TablesRelationalConfig, key: string, trashed: Trashed, withHidden: boolean): any {
  const out: any = { ...input }

  if (!withHidden && model.hidden.length > 0) {
    const columns: Record<string, boolean> | undefined = input?.columns
    const picksColumns = columns && Object.values(columns).some((v) => v === true)
    if (picksColumns) out.columns = omit(columns!, model.hidden)
    else out.columns = { ...columns, ...Object.fromEntries(model.hidden.map((h) => [h, false])) }
  }

  if (model.softDeletes && trashed !== 'include') {
    out.where = { [model.softDeletes]: trashed === 'only' ? { isNotNull: true } : { isNull: true } }
  }

  if (input?.with) {
    const entry = relations[key]!
    out.with = Object.fromEntries(
      Object.entries(input.with).map(([name, value]) => {
        const relation = entry.relations[name] as { relationType: 'one' | 'many'; targetTableName: string; targetTable: Table } | undefined
        const target = relation && modelsByTable.get(relation.targetTable)
        if (!value || !relation || !target) return [name, value]
        const nested = value === true ? {} : (value as Record<string, unknown>)
        const shaped = applyDefaults(target, { ...nested, where: undefined }, relations, relation.targetTableName, relation.relationType === 'many' ? 'exclude' : 'include', withHidden)
        const wheres = [nested.where, shaped.where].filter(Boolean)
        if (wheres.length === 0) delete shaped.where
        else shaped.where = wheres.length === 1 ? wheres[0] : { AND: wheres }
        return [name, shaped]
      }),
    )
  }
  return out
}

function serialize(model: RuntimeModel, rows: unknown, relationsOf: () => TablesRelationalConfig, table: Table): unknown {
  if (rows === null || rows === undefined) return rows
  if (Array.isArray(rows)) return rows.map((row) => serialize(model, row, relationsOf, table))
  if (typeof rows !== 'object') return rows
  const row = rows as Record<string, unknown>
  const out: Record<string, unknown> = { ...row }
  let entry: { relations: Record<string, { targetTable: Table }> } | undefined
  for (const [field, value] of Object.entries(row)) {
    if (value === null || typeof value !== 'object' || value instanceof Date) continue
    entry ??= Object.values(relationsOf()).find((e) => e.table === table) as typeof entry
    const relation = entry?.relations[field]
    const target = relation && modelsByTable.get(relation.targetTable)
    if (target) out[field] = serialize(target, value, relationsOf, relation.targetTable)
  }
  for (const [name, compute] of Object.entries(model.appends)) out[name] = compute(row as never)
  return out
}

function omit<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T {
  if (keys.length === 0) return row
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v
  return out as T
}
