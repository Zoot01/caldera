import { z } from 'zod'
import { EnvValidationError, type EnvIssue } from './errors.js'

export type EnvShape = Record<string, z.ZodType>

export type EnvOf<D> = D extends EnvDefinition<infer S> ? Readonly<z.output<z.ZodObject<S>>> : never

export interface EnvDefinition<S extends EnvShape> {
  readonly kind: 'caldera.env'
  readonly shape: S
  /** Validates a raw source (`process.env`, Workers `env`, …). Empty strings count as unset. */
  parse(source: Record<string, unknown>): Readonly<z.output<z.ZodObject<S>>>
  isSecret(key: string): boolean
  toJSONSchema(): unknown
}

export type AnyEnvDefinition = EnvDefinition<any>

const secrets = new WeakSet<z.ZodType>()

/** Marks an env schema as secret: its value is never shown by `describe()` or the CLI. */
export function secret<T extends z.ZodType>(schema: T): T {
  secrets.add(schema)
  return schema
}

// Names that almost always hold credentials are treated as secret even without `secret()`.
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|_KEY$|^KEY$|_DSN$|^DSN$|DATABASE_URL|REDIS_URL)/i

export function defineEnv<const S extends EnvShape>(shape: S): EnvDefinition<S> {
  const schema = z.object(shape)

  return {
    kind: 'caldera.env',
    shape,
    parse(source) {
      const input: Record<string, unknown> = {}
      for (const key of Object.keys(shape)) {
        const value = source[key]
        input[key] = value === '' ? undefined : value
      }
      const result = schema.safeParse(input)
      if (!result.success) {
        const issues: EnvIssue[] = result.error.issues.map((issue) => ({
          key: issue.path.length ? issue.path.map(String).join('.') : '(root)',
          message: issue.message,
        }))
        throw new EnvValidationError(issues)
      }
      return Object.freeze(result.data)
    },
    isSecret(key) {
      const field = shape[key]
      return (field !== undefined && secrets.has(field)) || SECRET_NAME.test(key)
    },
    toJSONSchema() {
      return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
    },
  }
}
