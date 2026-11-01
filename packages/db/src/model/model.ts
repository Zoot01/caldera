import { CalderaError, CapabilityError } from '@caldera-js/core'
import {
  eq,
  getColumns,
  getTableUniqueName,
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
export interface QueryApi<K extends TableKey, Reveal extends boolean = false> {
  findMany<C extends ManyConfig<K>>(config?: ManyConfig<K> extends C ? C : ManyConfig<K>): Promise<ModelResult<K, C, Reveal>[]>
  findFirst<C extends OneConfig<K>>(config?: OneConfig<K> extends C ? C : OneConfig<K>): Promise<ModelResult<K, C, Reveal> | undefined>
  find(id: string | number): Promise<ModelResult<K, true, Reveal> | undefined>
  /** Throws `ModelNotFoundError`, which `@caldera-js/http` renders as a 404. */
  findOrFail(id: string | number): Promise<ModelResult<K, true, Reveal>>
  /** Looks up by the model's `routeKey` (or primary key). Used by route model binding. */
  findByRouteKey(value: string | number): Promise<ModelResult<K, true, Reveal> | undefined>
  paginate<C extends ManyConfig<K>>(
    config: (ManyConfig<K> extends C ? C : ManyConfig<K>) & { page?: number; perPage?: number },
  ): Promise<Page<ModelResult<K, C, Reveal>>>
}

/** What a scope returns: the reads, and the other scopes to narrow further. */
export type Scoped<K extends TableKey, Sc> = QueryApi<K> & {
  [N in keyof Sc]: Sc[N] extends (...args: infer P) => any ? (...args: P) => Scoped<K, Sc> : never
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

/** A channel to broadcast on: `PostChannel.with({ post: row.id })` from `@caldera-js/broadcast`. */
export interface BroadcastChannelRef {
  readonly kind: 'caldera.channel-ref'
  readonly name: string
}
export type ModelBroadcastEvent = 'created' | 'updated' | 'deleted'

/**
 * Model broadcasting: after a write commits, browsers on `on(row)` get `<model>.created`, `.updated`
 * (restores too) or `.deleted` with `with(row)`. `with` is required, so a whole row (and whatever
 * columns are added to it later) never reaches the browser by default.
 */
export interface ModelBroadcast<R, W> {
  on: (row: R) => BroadcastChannelRef | readonly BroadcastChannelRef[]
  with: (row: R) => W
  /** Default: all three. */
  events?: readonly ModelBroadcastEvent[]
  /** Skip the browser that made the request (its X-Socket-ID). */
  toOthers?: boolean
}

export type Model<K extends TableKey, Name extends string, H extends string, G extends string, A, Sc, SD extends string = never, W = never> = QueryApi<K> & {
  readonly kind: 'caldera.model'
  readonly name: Name
  readonly table: S[K]['table']
  readonly '~key': K
  readonly '~hidden': H
  readonly '~guarded': G
  readonly '~appends': A
  readonly '~softDeletes': SD
  /** What browsers get from model broadcasting (`broadcast.with`), for typed hooks. */
  readonly '~broadcast': W
  /** Includes soft-deleted rows. */
  withTrashed(): QueryApi<K>
  /** Only soft-deleted rows. */
  onlyTrashed(): QueryApi<K>
  /** Includes hidden columns, e.g. to check a password hash. Never send the result to a client. */
  withHidden(): QueryApi<K, true>
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
  using(database: Database<any>): Model<K, Name, H, G, A, Sc, SD, W>
} & { [N in keyof Sc]: Sc[N] extends (...args: infer P) => any ? (...args: P) => Scoped<K, Sc> : never }

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
  /** The events it broadcasts, by the name browsers get, or null. */
  broadcast: string[] | null
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

export interface ModelConfig<T extends Table, Name extends string, H, G, A, Sc, SD, K extends TableKey, W = never> {
  name: Name
  hidden?: readonly H[]
  guarded?: readonly G[]
  softDeletes?: SD
  routeKey?: keyof SelOf<T> & string
  // The intersection gives scopes a contextual return type, so `{ isNull: true }` isn't widened.
  scopes?: Sc & Record<keyof Sc, (...args: any[]) => Filter<K>>
  appends?: { [P in keyof A]: (row: OmitKeys<SelOf<T>, H>) => A[P] }
  hooks?: Hooks<K, H, G>
  /** Sends created/updated/deleted to browsers after commit (needs broadcastProvider from @caldera-js/broadcast). */
  broadcast?: ModelBroadcast<OmitKeys<SelOf<T>, H>, W>
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
  W = never,
>(table: T, config: ModelConfig<T, Name, H, G, A, Sc, SD, K, W>): Model<K, Name, H, G, A, Sc, SD, W> {
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
  const broadcast = config.broadcast as ModelBroadcast<AnyRecord, unknown> | undefined
  const broadcastEvents: readonly ModelBroadcastEvent[] = broadcast ? (broadcast.events ?? ['created', 'updated', 'deleted']) : []
  // The app's broadcaster, as @caldera-js/broadcast registers it, read without depending on it.
  const broadcaster = () => {
    const found = (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.broadcast.default')] as
      | { prepare(on: unknown, event: string, data: unknown, options: { toOthers: boolean }): () => void }
      | undefined
    if (!found) throw new CalderaError('no_broadcast', `Model "${config.name}" broadcasts, which needs broadcastProvider() from @caldera-js/broadcast in the app.`)
    return found
  }
  // Prepared inside the write (a bad channel or an oversized payload fails it); sent after commit.
  const prepareBroadcast = (event: ModelBroadcastEvent, row: AnyRecord): (() => void) | undefined => {
    if (!broadcast || !broadcastEvents.includes(event)) return undefined
    return broadcaster().prepare(broadcast.on(row), `${config.name}.${event}`, broadcast.with(row), { toOthers: Boolean(broadcast.toOthers) })
  }
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
      const send = prepareBroadcast('created', result)
      if (send) await afterCommit(send)
      if (hooks.created) await afterCommit(() => hooks.created!(result))
      return result
    }

    // A broadcasting model's write runs in a transaction (a savepoint inside one), so a broadcast that
    // can't be sent (oversized, a bad channel) fails the write instead of following a committed one.
    // D1 and other drivers without interactive transactions can't: there it fails right after.
    const atomic = <F extends (...args: any[]) => Promise<any>>(fn: F): F =>
      (broadcast ? (...args: Parameters<F>) => (database().capabilities.interactiveTransactions ? database().transaction(() => fn(...args)) : fn(...args)) : fn) as F
    const write = {
      create: atomic((input: Record<string, unknown>) => insert(omit(input, runtime.guarded))),
      forceCreate: atomic((input: Record<string, unknown>) => insert(input)),
      createMany: atomic(async (inputs: Record<string, unknown>[]) => {
        const rows = []
        for (const input of inputs) rows.push(await insert(omit(input, runtime.guarded)))
        return rows
      }),
      update: atomic(async (ref: RowRef, patch: Record<string, unknown>) => {
        requireReturning()
        const before = await resolve(ref)
        const id = before[primaryKey]
        const cleaned = omit(patch, runtime.guarded)
        const prepared = hooks.updating ? await hooks.updating({ before, patch: cleaned }) : cleaned
        // Nothing left to write (an empty patch, only guarded columns, or undefined values, which
        // Drizzle skips): no query, no hooks.
        if (Object.values(prepared).every((value) => value === undefined)) return before
        const [row] = await client()
          .update(table)
          .set(prepared)
          .where(eq((table as any)[primaryKey], id))
          .returning()
        if (!row) throw new ModelNotFoundError(config.name, id)
        const after = visible(row)
        const send = prepareBroadcast('updated', after)
        if (send) await afterCommit(send)
        if (hooks.updated) await afterCommit(() => hooks.updated!({ before, patch: prepared, after }))
        return after
      }),
      delete: atomic(async (ref: RowRef) => {
        const row = await resolve(ref)
        if (hooks.deleting) await hooks.deleting(row)
        const id = row[primaryKey]
        if (sdColumn) await client().update(table).set({ [runtime.softDeletes!]: new Date() }).where(eq((table as any)[primaryKey], id))
        else await client().delete(table).where(eq((table as any)[primaryKey], id))
        const send = prepareBroadcast('deleted', row)
        if (send) await afterCommit(send)
        if (hooks.deleted) await afterCommit(() => hooks.deleted!(row, { soft: Boolean(sdColumn) }))
      }),
      forceDelete: atomic(async (ref: RowRef) => {
        const row = await resolve(ref, 'include')
        if (hooks.deleting) await hooks.deleting(row)
        await client().delete(table).where(eq((table as any)[primaryKey], row[primaryKey]))
        const send = prepareBroadcast('deleted', row)
        if (send) await afterCommit(send)
        if (hooks.deleted) await afterCommit(() => hooks.deleted!(row, { soft: false }))
      }),
      restore: atomic(async (ref: RowRef) => {
        if (!sdColumn) throw new CalderaError('model_definition', `Model "${config.name}" doesn't use softDeletes.`)
        requireReturning()
        const row = await resolve(ref, 'only')
        const [restored] = await client()
          .update(table)
          .set({ [runtime.softDeletes!]: null })
          .where(eq((table as any)[primaryKey], row[primaryKey]))
          .returning()
        const result = visible(restored)
        const send = prepareBroadcast('updated', result)
        if (send) await afterCommit(send)
        return result
      }),
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
        broadcast: broadcast ? broadcastEvents.map((event) => `${config.name}.${event}`) : null,
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
  let key = byTable.get(table)
  if (!key) {
    // The same table from another copy of the module (Next.js bundles route handlers and pages
    // separately, so one process can hold two copies of the app): match it by schema and name.
    const name = getTableUniqueName(table)
    key = Object.entries(relations).find(([, entry]) => getTableUniqueName(entry.table as Table) === name)?.[0]
    if (key) byTable.set(table, key)
  }
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
