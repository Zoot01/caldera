import type { InferSchemaEntrySelectModel, TablesRelationalConfig } from 'drizzle-orm'

/**
 * Apps register their Drizzle relations here; `caldera generate` writes it:
 * `declare module '@caldera/db' { interface DatabaseRegister { relations: typeof relations } }`
 */
export interface DatabaseRegister {}

/** Relations key → model. Codegen fills it so nested results drop hidden columns and serialize appends. */
export interface ModelRegistry {}

export type S = DatabaseRegister extends { relations: infer R extends TablesRelationalConfig } ? R : TablesRelationalConfig
export type TableKey = keyof S & string

export type Select<K extends TableKey> = InferSchemaEntrySelectModel<S[K]['table']>
export type InsertRaw<K extends TableKey> = S[K]['table'] extends { $inferInsert: infer I } ? I : never

export type HiddenOf<K> = K extends keyof ModelRegistry
  ? ModelRegistry[K] extends { readonly '~hidden': infer H extends string }
    ? H
    : never
  : never

export type AppendsOf<K> = K extends keyof ModelRegistry
  ? ModelRegistry[K] extends { readonly '~appends': infer A }
    ? A
    : {}
  : {}

/** Key-remapping omit: cheaper for the checker than `Omit` (measured in prototypes/typecheck). */
export type OmitKeys<T, H> = [H] extends [never] ? T : { [P in keyof T as P extends H ? never : P]: T[P] }

export type RelationsOf<K extends TableKey> = S[K]['relations']
export type TargetOf<K extends TableKey, R> = R extends keyof RelationsOf<K>
  ? RelationsOf<K>[R] extends { targetTableName: infer T extends TableKey }
    ? T
    : never
  : never

export type KeyOfTable<T> = { [K in TableKey]: S[K]['table'] extends T ? K : never }[TableKey]
