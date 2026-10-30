import type { RegisteredEnv } from './register.js'

/**
 * A named piece of config. The factory is the only place the env is readable, which
 * enforces Laravel's "env() only in config files" rule at the type level.
 */
export interface ConfigDefinition<N extends string, T> {
  readonly kind: 'caldera.config'
  readonly name: N
  readonly resolve: (env: RegisteredEnv) => T
}

export type AnyConfigDefinition = ConfigDefinition<string, any>

export type ConfigMap<C extends readonly AnyConfigDefinition[]> = {
  readonly [D in C[number] as D['name']]: D extends ConfigDefinition<string, infer T> ? Readonly<T> : never
}

export function defineConfig<const N extends string, T>(name: N, factory: (env: RegisteredEnv) => T): ConfigDefinition<N, T> {
  return { kind: 'caldera.config', name, resolve: factory }
}
