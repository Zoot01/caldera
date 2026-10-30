import type { AnyConfigDefinition, ConfigMap } from './config.js'
import type { AnyEnvDefinition, EnvOf } from './env.js'

/**
 * Apps register their env and config definitions here so `defineConfig` and
 * `defineProvider` callbacks are typed without importing the app (which would
 * create an import cycle). `caldera` codegen writes this into `.caldera/register.d.ts`:
 *
 * ```ts
 * declare module '@caldera/core' {
 *   interface Register { env: typeof env; config: typeof config }
 * }
 * ```
 */
export interface Register {}

/**
 * Stand-in type before codegen has run. Reading any key fails with an error whose
 * message names the fix, instead of a vague "is of type 'unknown'".
 */
export interface NotGenerated {
  readonly 'Run `caldera generate` to type env and config': true
}

export type RegisteredEnv = Register extends { env: infer E extends AnyEnvDefinition } ? EnvOf<E> : NotGenerated

export type RegisteredConfig = Register extends { config: infer C extends readonly AnyConfigDefinition[] } ? ConfigMap<C> : NotGenerated
