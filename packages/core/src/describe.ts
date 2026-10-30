import type { AnyConfigDefinition } from './config.js'
import type { AnyEnvDefinition } from './env.js'
import type { AnyProvider } from './provider.js'

export const SCHEMA_VERSION = 1
export const REDACTED = '[redacted]'

export interface AppDescription {
  schemaVersion: typeof SCHEMA_VERSION
  state: string
  env: {
    schema: unknown
    keys: { name: string; secret: boolean; present: boolean | null }[]
  }
  /** Resolved config with secrets redacted, or `null` before boot. */
  config: Record<string, unknown> | null
  providers: {
    name: string
    dependsOn: string[]
    services: { name: string; lifetime: 'singleton' | 'value' | 'request' }[]
    hooks: { boot: boolean; shutdown: boolean }
  }[]
}

interface DescribeInput {
  state: string
  envDefinition: AnyEnvDefinition
  configs: readonly AnyConfigDefinition[]
  order: readonly AnyProvider[]
  booted:
    | {
        env: Record<string, unknown>
        config: Record<string, unknown>
        registered: Record<string, { name: string; lifetime: 'singleton' | 'value' }[]>
      }
    | undefined
}

/**
 * A JSON-safe snapshot of the app for the CLI (`caldera describe --json`), MCP tools
 * and generated AGENTS.md. Never contains secret values. Calling it doesn't build any service.
 */
export function describeApp({ state, envDefinition, configs, order, booted }: DescribeInput): AppDescription {
  const envKeys = Object.keys(envDefinition.shape)
  const secretValues = new Set<string>()
  if (booted) {
    for (const key of envKeys) {
      const value = booted.env[key]
      if (envDefinition.isSecret(key) && typeof value === 'string' && value.length > 0) secretValues.add(value)
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    state,
    env: {
      schema: envDefinition.toJSONSchema(),
      keys: envKeys.map((name) => ({
        name,
        secret: envDefinition.isSecret(name),
        present: booted ? booted.env[name] !== undefined : null,
      })),
    },
    config: booted
      ? Object.fromEntries(configs.map((c) => [c.name, redact(booted.config[c.name], secretValues, 0)]))
      : null,
    providers: order.map((provider) => ({
      name: provider.name,
      dependsOn: provider.dependsOn.map((d) => d.name),
      services: [
        // `register` only runs at boot, so these names are known only once the app has booted.
        ...(booted?.registered[provider.name] ?? []),
        ...Object.keys(provider.request ?? {}).map((name) => ({ name, lifetime: 'request' as const })),
      ],
      hooks: { boot: Boolean(provider.boot), shutdown: Boolean(provider.shutdown) },
    })),
  }
}

const SECRET_KEY = /(secret|token|password|passwd|apikey|api_key|privatekey|private_key|credential)/i
const MAX_DEPTH = 6

function redact(value: unknown, secretValues: Set<string>, depth: number): unknown {
  if (typeof value === 'string') return secretValues.has(value) || containsSecret(value, secretValues) ? REDACTED : value
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'undefined') return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[function]'
  if (depth >= MAX_DEPTH) return '[…]'
  if (Array.isArray(value)) return value.map((v) => redact(v, secretValues, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return `[${proto?.constructor?.name ?? 'object'}]`
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v != null ? REDACTED : redact(v, secretValues, depth + 1)]),
    )
  }
  return String(value)
}

// Catches secrets embedded in larger strings, e.g. a password inside a connection URL.
function containsSecret(value: string, secretValues: Set<string>): boolean {
  for (const secret of secretValues) if (secret.length >= 8 && value.includes(secret)) return true
  return false
}
