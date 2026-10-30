import { CalderaError } from '@caldera/core'
import { Faker, en } from '@faker-js/faker'
import { getColumns, type Table, type TablesRelationalConfig } from 'drizzle-orm'
import { defaultDatabase } from './database.js'
import type { AnyModel, Row } from './model/model.js'
import type { InsertRaw, RelationsOf } from './model/registry.js'

// Faker is seeded once per process so a failing test can be replayed: print `factorySeed()`
// and rerun with CALDERA_SEED=<seed>.
let seed = Number(globalThis.process?.env?.CALDERA_SEED) || Math.floor(Math.random() * 2 ** 31)
const faker = new Faker({ locale: [en] })
faker.seed(seed)
const sequences = new Map<object, number>()

export function factorySeed(): number {
  return seed
}

/** Reseeds faker and resets every `seq` counter, making the next factory output reproducible. */
export function setFactorySeed(value: number) {
  seed = value
  faker.seed(value)
  sequences.clear()
}

type Attrs<M extends AnyModel> = Partial<InsertRaw<M['~key']>>

export interface FactoryContext {
  faker: Faker
  /** 1, 2, 3… per factory: use it for unique columns so they never collide. */
  seq: number
}

export interface FactoryDefinition<M extends AnyModel, St> {
  readonly kind: 'caldera.factory'
  readonly model: M
  readonly definition: (ctx: FactoryContext) => Attrs<M>
  readonly states: St
  readonly afterCreating?: (row: Row<M>, ctx: FactoryContext) => unknown
}

/**
 * Describes how to build fake rows for a model. Keep factories in `src/db/factories/`: they import
 * faker, so they must never be imported by production code.
 */
export function defineFactory<M extends AnyModel, St extends Record<string, (attrs: Attrs<M>) => Attrs<M>> = {}>(
  model: M,
  definition: {
    definition: (ctx: FactoryContext) => Attrs<M>
    /** Named variations, returned as partial attributes: `admin: () => ({ role: 'admin' })`. */
    states?: St
    afterCreating?: (row: Row<M>, ctx: FactoryContext) => unknown
  },
): FactoryDefinition<M, St> {
  return { kind: 'caldera.factory', model, states: (definition.states ?? {}) as St, ...definition }
}

type RelationName<M extends AnyModel> = keyof RelationsOf<M['~key']> & string

/** Structural view of any builder, used where builders of other models are accepted. */
export interface BuilderLike<Out> {
  readonly kind: 'caldera.factory-builder'
  with(attrs: Record<string, unknown>): BuilderLike<Out>
  make(): Promise<Out | Out[]>
  create(): Promise<Out | Out[]>
}
type AnyBuilder = BuilderLike<any>

export type FactoryBuilder<M extends AnyModel, St, Many extends boolean, Out> = {
  readonly kind: 'caldera.factory-builder'
  /** Build `n` rows: `create()` then returns an array. */
  count(n: number): FactoryBuilder<M, St, true, Out>
  /** Fixed attributes, applied last. */
  with(attrs: Attrs<M>): FactoryBuilder<M, St, Many, Out>
  /** Cycles through the given attributes, one per row. */
  sequence(...attrs: Attrs<M>[]): FactoryBuilder<M, St, Many, Out>
  /** Belongs-to: creates (or `make`s) one parent for all rows and sets the foreign key. */
  for(relation: RelationName<M>, parent: AnyBuilder | Record<string, unknown>): FactoryBuilder<M, St, Many, Out>
  /** Has-many: creates children for each row and returns them on it. */
  has<const R extends RelationName<M>, C>(relation: R, children: BuilderLike<C>): FactoryBuilder<M, St, Many, Out & { [K in R]: C[] }>
  /** Reuses existing rows of a model as parents instead of creating new ones. */
  recycle(model: AnyModel, rows: readonly Record<string, unknown>[]): FactoryBuilder<M, St, Many, Out>
  /** Attributes only: no database, no ids, no parents. */
  raw(): Promise<Many extends true ? Attrs<M>[] : Attrs<M>>
  /** Row-shaped objects with fake ids. Never touches the database, not even for parents. */
  make(): Promise<Many extends true ? Out[] : Out>
  /** Inserts through the model (hooks fire), the whole graph in one transaction where supported. */
  create(): Promise<Many extends true ? Out[] : Out>
} & { [S in keyof St]: () => FactoryBuilder<M, St, Many, Out> }

interface BuilderState {
  count: number | undefined
  states: string[]
  attrs: Record<string, unknown>
  sequence: Record<string, unknown>[]
  parents: { relation: string; parent: AnyBuilder | Record<string, unknown> }[]
  children: { relation: string; builder: AnyBuilder }[]
  recycled: { table: Table; rows: readonly Record<string, unknown>[] }[]
}

interface RelationInfo {
  relationType: 'one' | 'many'
  targetTable: Table
  sourceColumns: { _: { column: unknown } }[]
  targetColumns: { _: { column: unknown } }[]
}

/** Starts building rows from a factory: `factory(UserFactory).admin().count(3).create()`. */
export function factory<M extends AnyModel, St>(definition: FactoryDefinition<M, St>): FactoryBuilder<M, St, false, Row<M>> {
  return builder(definition as unknown as FactoryDefinition<AnyModel, any>, { count: undefined, states: [], attrs: {}, sequence: [], parents: [], children: [], recycled: [] }) as never
}

function builder(def: FactoryDefinition<AnyModel, any>, state: BuilderState): AnyBuilder {
  const next = (patch: Partial<BuilderState>) => builder(def, { ...state, ...patch })
  const model = def.model as AnyModel & { forceCreate(attrs: unknown): Promise<Record<string, unknown>> }
  const table = model.table

  const context = (): FactoryContext => {
    const seq = (sequences.get(def) ?? 0) + 1
    sequences.set(def, seq)
    return { faker, seq }
  }

  const attributes = (index: number, ctx: FactoryContext) => {
    let attrs: Record<string, unknown> = { ...(def.definition(ctx) as Record<string, unknown>) }
    for (const name of state.states) attrs = { ...attrs, ...(def.states as Record<string, (a: unknown) => object>)[name]!(attrs) }
    if (state.sequence.length > 0) attrs = { ...attrs, ...state.sequence[index % state.sequence.length] }
    return { ...attrs, ...state.attrs }
  }

  const relationsInfo = (): { relations: TablesRelationalConfig; key: string } => {
    const relations = (defaultDatabase().current() as { _?: { relations?: TablesRelationalConfig } })._?.relations
    if (!relations) throw new CalderaError('model_definition', 'Factories need a Drizzle client created with `relations`.')
    const key = Object.keys(relations).find((k) => relations[k]!.table === table)
    if (!key) throw new CalderaError('model_definition', `The "${model.name}" table is missing from the Drizzle relations.`)
    return { relations, key }
  }
  const relation = (name: string): RelationInfo => {
    const { relations, key } = relationsInfo()
    const found = relations[key]!.relations[name] as unknown as RelationInfo | undefined
    if (!found) throw new CalderaError('unknown_relation', `Model "${model.name}" has no relation "${name}".`)
    return found
  }

  // Each `for()` parent is resolved once per create()/make() call and shared by every row.
  const resolveParents = async (mode: 'make' | 'create') => {
    const values: Record<string, unknown> = {}
    for (const { relation: name, parent } of state.parents) {
      const info = relation(name)
      const recycled = state.recycled.find((r) => r.table === info.targetTable)?.rows
      const row = recycled?.length
        ? faker.helpers.arrayElement(recycled)
        : isBuilder(parent)
          ? ((await (mode === 'make' ? parent.make() : parent.create())) as Record<string, unknown>)
          : parent
      info.sourceColumns.forEach((source, i) => {
        values[propertyOf(table, source._.column)] = row[propertyOf(info.targetTable, info.targetColumns[i]!._.column)]
      })
    }
    return values
  }

  // Checked before any row is written, so misuse never leaves partial data behind.
  const validateRelations = () => {
    for (const { relation: name } of state.parents) {
      if (relation(name).relationType !== 'one') throw new CalderaError('unknown_relation', `for() needs a belongs-to relation; "${name}" is has-many. Use has().`)
    }
    for (const { relation: name } of state.children) {
      if (relation(name).relationType !== 'many') throw new CalderaError('unknown_relation', `has() needs a has-many relation; "${name}" is belongs-to. Use for().`)
    }
  }

  const run = async (mode: 'make' | 'create') => {
    validateRelations()
    const parentValues = await resolveParents(mode)
    const rows: Record<string, unknown>[] = []
    for (let index = 0; index < (state.count ?? 1); index++) {
      const ctx = context()
      const attrs = { ...attributes(index, ctx), ...parentValues }
      let row: Record<string, unknown>
      if (mode === 'make') {
        row = { ...fakePrimaryKey(table, ctx), ...attrs }
      } else {
        row = await model.forceCreate(attrs)
        await def.afterCreating?.(row as never, ctx)
      }
      for (const { relation: name, builder: children } of state.children) {
        const info = relation(name)
        const childTable = info.targetTable
        const link = Object.fromEntries(
          info.targetColumns.map((target, i) => [propertyOf(childTable, target._.column), row[propertyOf(table, info.sourceColumns[i]!._.column)]]),
        )
        const made = await children.with(link)[mode]()
        row = { ...row, [name]: Array.isArray(made) ? made : [made] }
      }
      rows.push(row)
    }
    return state.count === undefined ? rows[0] : rows
  }

  const api: Record<string, unknown> = {
    kind: 'caldera.factory-builder',
    count: (n: number) => next({ count: n }),
    with: (attrs: Record<string, unknown>) => next({ attrs: { ...state.attrs, ...attrs } }),
    sequence: (...attrs: Record<string, unknown>[]) => next({ sequence: attrs }),
    for: (name: string, parent: AnyBuilder | Record<string, unknown>) => next({ parents: [...state.parents, { relation: name, parent }] }),
    has: (name: string, children: AnyBuilder) => next({ children: [...state.children, { relation: name, builder: children }] }),
    recycle: (other: AnyModel, rows: readonly Record<string, unknown>[]) => next({ recycled: [...state.recycled, { table: other.table, rows }] }),
    async raw() {
      const rows = Array.from({ length: state.count ?? 1 }, (_, index) => attributes(index, context()))
      return state.count === undefined ? rows[0] : rows
    },
    make: () => run('make'),
    async create() {
      const db = defaultDatabase()
      return db.capabilities.interactiveTransactions ? db.transaction(() => run('create')) : run('create')
    },
  }
  for (const name of Object.keys(def.states)) api[name] = () => next({ states: [...state.states, name] })
  return api as unknown as AnyBuilder
}

function isBuilder(value: unknown): value is AnyBuilder {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'caldera.factory-builder'
}

function propertyOf(table: Table, column: unknown): string {
  const columns = getColumns(table) as Record<string, unknown>
  const key = Object.keys(columns).find((k) => columns[k] === column)
  if (!key) throw new CalderaError('model_definition', 'A relation refers to a column its table does not have.')
  return key
}

function fakePrimaryKey(table: Table, ctx: FactoryContext): Record<string, unknown> {
  const columns = getColumns(table) as Record<string, { primary: boolean; getSQLType(): string }>
  const key = Object.keys(columns).find((k) => columns[k]!.primary)
  if (!key) return {}
  return { [key]: columns[key]!.getSQLType() === 'uuid' ? crypto.randomUUID() : ctx.seq }
}

