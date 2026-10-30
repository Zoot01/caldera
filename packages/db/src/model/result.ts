import type { AnyRelation, InferRelationalQueryTableResult, RelationResultKind, Simplify, SQLWrapper, TruthyKeysOnly } from 'drizzle-orm'
import type { HiddenOf, OmitKeys, RelationsOf, Select, TableKey } from './registry.js'

// Single-pass result builder modelled on Drizzle's BuildQueryResult: hidden columns are
// dropped while each level is built. Post-processing with a recursive Omit cost ~2x.

type Extras<C> = C extends { extras: infer E extends Record<string, unknown> }
  ? {
      [P in keyof E]: E[P] extends (...a: any[]) => infer R
        ? R extends { _: { type: infer T } }
          ? T
          : unknown
        : E[P] extends SQLWrapper & { _: { type: infer T } }
          ? T
          : unknown
    }
  : {}

type Columns<K extends TableKey, C> = C extends { columns: infer Cols extends Record<string, unknown> }
  ? InferRelationalQueryTableResult<OmitKeys<Select<K>, HiddenOf<K>>, Cols>
  : OmitKeys<Select<K>, HiddenOf<K>>

type Rels<K extends TableKey, W> = {
  [R in TruthyKeysOnly<W> & keyof RelationsOf<K>]: RelationsOf<K>[R] extends infer Rel extends AnyRelation
    ? RelationResultKind<Build<Rel['targetTableName'] & TableKey, W[R]>, W[R], Rel>
    : never
}

export type Build<K extends TableKey, C> = C extends true | Record<string, never>
  ? OmitKeys<Select<K>, HiddenOf<K>>
  : Simplify<Columns<K, C> & Extras<C> & (C extends { with: infer W } ? Rels<K, W> : {})>

export type ModelResult<K extends TableKey, C> = Build<K, C>
