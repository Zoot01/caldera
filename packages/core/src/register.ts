import type { AppServices, CalderaApp, HonoEnvOf } from './app.js'
import type { AnyConfigDefinition, ConfigMap } from './config.js'
import type { AnyEnvDefinition, EnvOf } from './env.js'

/**
 * Apps register their env and config definitions here so `defineConfig` and
 * `defineProvider` callbacks are typed without importing the app (which would
 * create an import cycle). `caldera` codegen writes this into `.caldera/register.d.ts`:
 *
 * ```ts
 * declare module '@caldera-js/core' {
 *   interface Register { env: typeof env; config: typeof config; app: typeof app }
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

/**
 * The Hono env of the registered app, so route handlers see typed `c.var` services
 * without passing a type argument. `app` is optional: codegen adds it when `src/app.ts`
 * exports one. Nothing the app's own type depends on may read it, or the types would cycle.
 */
export type RegisteredHonoEnv = Register extends { app: infer A } ? HonoEnvOf<A> : {}

/**
 * The registered app's process-wide services, for code that runs outside a request: jobs, event
 * listeners, scheduled tasks. The same caveat as `RegisteredHonoEnv` applies.
 */
export type RegisteredServices = Register extends { app: infer A } ? (A extends CalderaApp<any, any, infer P> ? AppServices<P> : {}) : {}
