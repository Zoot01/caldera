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

// `withHidden()` reveals hidden columns at every level, so Reveal is passed down through relations.
type Visible<K extends TableKey, Reveal extends boolean> = Reveal extends true ? Select<K> : OmitKeys<Select<K>, HiddenOf<K>>

type Columns<K extends TableKey, C, Reveal extends boolean> = C extends { columns: infer Cols extends Record<string, unknown> }
  ? InferRelationalQueryTableResult<Visible<K, Reveal>, Cols>
  : Visible<K, Reveal>

type Rels<K extends TableKey, W, Reveal extends boolean> = {
  [R in TruthyKeysOnly<W> & keyof RelationsOf<K>]: RelationsOf<K>[R] extends infer Rel extends AnyRelation
    ? RelationResultKind<Build<Rel['targetTableName'] & TableKey, W[R], Reveal>, W[R], Rel>
    : never
}

export type Build<K extends TableKey, C, Reveal extends boolean = false> = C extends true | Record<string, never>
  ? Visible<K, Reveal>
  : Simplify<Columns<K, C, Reveal> & Extras<C> & (C extends { with: infer W } ? Rels<K, W, Reveal> : {})>

export type ModelResult<K extends TableKey, C, Reveal extends boolean = false> = Build<K, C, Reveal>
